/**
 * The fix tier, in-process.
 *
 * This used to be a separate service (apps/fixes on :8082) that the web app
 * called over HTTP. That hop bought nothing the process boundary already
 * gives: this module is `server-only`, so AUTOFIX_GEMINI_API stays out of the
 * client bundle exactly as it stayed out of the browser when a second process
 * held it. The extra server was one more thing to start (and forget to start —
 * every "Could not reach the fix writer" was that), so the model call now
 * lives here, next to the entitlement checks that decide who may spend it.
 *
 * What the web app still owns and what this file keeps: who may ask (decided
 * in the route, not here) and which finding they are asking about (loaded from
 * the database server-side, never taken from the request body — a
 * client-supplied finding text would let anyone generate fixes for content
 * their plan never unlocked).
 *
 * A failed generation degrades to a clear sentence from the Fix button, not a
 * thrown 500.
 */

import 'server-only'
import { ApiError, GoogleGenAI, type GenerateContentResponse } from '@google/genai'
import { serverEnv } from './env.ts'

/** Enough of a finding for the model to write a real work order. */
export interface FixFinding {
  checkId: string
  category: string
  severity: string
  title: string
  description?: string | null
  evidence?: Record<string, unknown> | null
  remediation?: string | null
  siteUrl?: string | null
}

export type FixGeneration =
  | { ok: true; prompt: string }
  | { ok: false; reason: 'unconfigured' | 'busy' | 'upstream' | 'network' }

/**
 * What a failed generation becomes on the wire. Pure, so the contract the Fix
 * button codes against — which failures are retryable, which status each
 * reason carries — is asserted by a test rather than read out of a route.
 *
 * Only the transient reasons are retryable: busy, upstream and network can go
 * away on the next press. Unconfigured cannot — no retry reaches the env.
 */
export type FixFailureReason = 'unconfigured' | 'busy' | 'upstream' | 'network'

export function fixFailure(reason: FixFailureReason): {
  status: number
  body: { error: string; retryable: boolean }
} {
  const messages: Record<FixFailureReason, string> = {
    unconfigured:
      'Fix prompts are not configured on this deployment. Set AUTOFIX_GEMINI_API.',
    busy: 'The model is throttling right now. Try again in a moment.',
    upstream: 'The model could not write a fix prompt. Try again.',
    network: 'Could not reach the AI model. Check your connection and try again.',
  }
  return {
    status: reason === 'unconfigured' ? 503 : 502,
    body: {
      error: messages[reason],
      retryable: reason !== 'unconfigured',
    },
  }
}

/**
 * The master prompt — the one piece of wording the whole feature rests on.
 *
 * The product's promise is "the prompt that fixes it": not advice about the
 * issue, but a work order precise enough that an AI coding agent (Cursor,
 * Claude Code, Copilot Workspace) can act on it without the user writing a
 * word. The model is told what the output IS, what it may use, and where the
 * edges are — because an LLM handed a finding will happily pad it with
 * invented context, and an invented fix is worse than none.
 *
 * Kept as a static string rather than beside the scan engine on purpose: the
 * `fixPrompt` the engine stamps on every finding at scan time is built from
 * templates in @scanlyfix/checks and frozen in the report. This one is
 * generated per request, so its wording can improve without touching stored
 * rows.
 */
const MASTER_PROMPT = `You write fix prompts for ScanlyFix, a tool that scans websites and hands each finding to the developer's AI coding agent as a ready-to-run work order.

You will receive ONE finding from a scan: its check id, pillar, severity, title, description, the evidence observed at scan time, the engine's own remediation hint, and the site it was found on.

Write ONE prompt that the developer can paste into their AI coding agent (Cursor, Claude Code, Codex) to fix this issue in their codebase. The prompt is the entire output — no preamble, no explanation to the developer, no markdown headings outside the prompt itself.

Rules:
- Address the agent directly ("Add ...", "Replace ...", "Configure ...") and be concrete about files or places when the evidence names them.
- Use the evidence. If a header value, snippet or URL was observed, quote the relevant part so the agent verifies against reality rather than guessing.
- Give the exact change where you can: the header to set, the attribute to add, the config block, the pattern to replace with.
- Do not invent facts the finding does not support — no imagined frameworks, file paths or stack. If the evidence is thin, write the prompt so the agent first locates the right place, then applies the fix.
- Include a short verification step at the end (how to confirm the issue is gone).
- At most ~200 words. Plain text. Every sentence either locates the problem, fixes it, or verifies the fix.`

/** The free-tier model, tested live before wiring. Override with FIXES_MODEL. */
const DEFAULT_MODEL = 'gemini-2.5-flash'

/**
 * The free tier's throttles are per-model, so the failures another model could
 * survive fall through to the next-cheapest free Gemini. A fixed list rather
 * than a discovered one: Google's catalogue is curated (no embed/guard strays
 * to filter out), and one fallback covers the per-model 429/5xx storms without
 * an extra network call to enumerate models on every failure.
 */
const FALLBACK_MODELS = ['gemini-2.5-flash-lite'] as const

/**
 * What a completion attempt can conclude with. `canFallback` marks the
 * failures where a DIFFERENT model plausibly succeeds: the free tier's 429s
 * are per-model, and a 5xx or an empty completion is one model having a
 * bad moment. Key-level refusals (401/402/403) fail for every model, so they
 * end the attempt chain — retrying a rejected key against other models just
 * multiplies the wait.
 */
type Attempt =
  | { ok: true; prompt: string }
  | { ok: false; reason: FixFailureReason; canFallback: boolean }

/**
 * A fix prompt is ~200 words; the ceiling exists so a runaway becomes a
 * failure, not a bill. Thinking is disabled outright (flash supports a zero
 * budget): the master prompt already pins the format, a thinking pass would
 * burn free-tier tokens before the first word, and with it off the ceiling
 * never competes with reasoning for output room.
 */
const MAX_TOKENS = 1200

/**
 * The user content for one request: the finding as JSON. Pure, so the exact
 * wording leaving the backend is asserted by a test rather than reviewed by
 * hope. The master prompt rides separately, as the system instruction.
 */
export function buildUserPrompt(finding: FixFinding): string {
  return JSON.stringify({
    siteUrl: finding.siteUrl ?? null,
    checkId: finding.checkId,
    pillar: finding.category,
    severity: finding.severity,
    title: finding.title,
    description: finding.description ?? null,
    evidence: finding.evidence ?? null,
    remediationHint: finding.remediation ?? null,
  })
}

async function attemptModel(model: string, finding: FixFinding): Promise<Attempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timer.unref()

  let response: GenerateContentResponse
  try {
    const ai = new GoogleGenAI({ apiKey: serverEnv.autofixGeminiApiKey })
    response = await ai.models.generateContent({
      model,
      contents: buildUserPrompt(finding),
      config: {
        systemInstruction: MASTER_PROMPT,
        temperature: 0.2,
        maxOutputTokens: MAX_TOKENS,
        thinkingConfig: { thinkingBudget: 0 },
        abortSignal: controller.signal,
      },
    })
  } catch (error) {
    clearTimeout(timer)
    if (error instanceof ApiError) {
      // Server-side log only: the visitor gets the generic sentence, the
      // operator gets the status and enough of the message to act on.
      console.error('gemini refused', error.status, String(error.message).slice(0, 300))
      if (error.status === 429) return { ok: false, reason: 'busy', canFallback: true }
      // 401/402/403 are properties of the KEY — another model changes nothing.
      const keyLevel = error.status === 401 || error.status === 402 || error.status === 403
      return { ok: false, reason: 'upstream', canFallback: !keyLevel }
    }
    // Everything the SDK throws that is not an HTTP refusal is transport
    // trouble (timeout, DNS, aborted connection) — the retry button's domain.
    return { ok: false, reason: 'network', canFallback: false }
  }
  clearTimeout(timer)

  const text = typeof response.text === 'string' ? response.text.trim() : ''
  if (text === '') {
    return { ok: false, reason: 'upstream', canFallback: true }
  }

  return { ok: true, prompt: text }
}

/** A slow model is worse than a failed one: the UI has a retry button, not a patience test. */
const TIMEOUT_MS = 45_000

/**
 * One finding, one prompt: the configured model first, then — only on the
 * failures another model could survive — the free fallback Gemini.
 *
 * Retries are still the CALLER's decision for the SAME model (the retry
 * button is a product behaviour, shown to a person); what this buys is that
 * one model's bad moment no longer dead-ends the feature.
 */
export async function generateFix(finding: FixFinding): Promise<FixGeneration> {
  if (!serverEnv.fixesConfigured) return { ok: false, reason: 'unconfigured' }

  const primary = serverEnv.fixesModel || DEFAULT_MODEL
  const chain = [primary, ...FALLBACK_MODELS.filter((model) => model !== primary)]
  let last: FixFailureReason = 'upstream'
  for (const model of chain) {
    const attempt = await attemptModel(model, finding)
    if (attempt.ok) return attempt
    if (!attempt.canFallback) return { ok: false, reason: attempt.reason }
    last = attempt.reason
  }
  return { ok: false, reason: last }
}

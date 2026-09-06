/**
 * The fix tier, in-process.
 *
 * This used to be a separate service (apps/fixes on :8082) that the web app
 * called over HTTP. That hop bought nothing the process boundary already
 * gives: this module is `server-only`, so OPENROUTER_API_KEY stays out of the
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
      'Fix prompts are not configured on this deployment. Set OPENROUTER_API_KEY.',
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
const DEFAULT_MODEL = 'minimax/minimax-m3:free'

/**
 * What a completion attempt can conclude with. `canFallback` marks the
 * failures where a DIFFERENT model plausibly succeeds: the free tier's 429s
 * are per-model, and a 5xx or an empty completion is one provider having a
 * bad moment. Key-level refusals (401/402/403) fail for every model, so they
 * end the attempt chain — retrying a rejected key against other models just
 * multiplies the wait.
 */
type Attempt =
  | { ok: true; prompt: string }
  | { ok: false; reason: FixFailureReason; canFallback: boolean }

/** A completion is ~200 words; the ceiling exists so a runaway becomes a failure, not a bill. Reasoning models spend completion tokens thinking before they write, so the ceiling has to leave room for the thinking too. */
const MAX_TOKENS = 1500

async function attemptModel(model: string, finding: FixFinding): Promise<Attempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  timer.unref()

  let response: Response
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serverEnv.openrouterApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(finding),
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
      }),
      signal: controller.signal,
    })
  } catch {
    return { ok: false, reason: 'network', canFallback: false }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    // Server-side log only: the visitor gets the generic sentence, the
    // operator gets the status and enough of the body to act on.
    console.error('openrouter refused', response.status, body.slice(0, 300))
    if (response.status === 429) return { ok: false, reason: 'busy', canFallback: true }
    // 401/402/403 are properties of the KEY — another model changes nothing.
    const keyLevel = response.status === 401 || response.status === 402 || response.status === 403
    return { ok: false, reason: 'upstream', canFallback: !keyLevel }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'upstream', canFallback: true }
  }

  const choice = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message
  if (typeof choice?.content !== 'string' || choice.content.trim() === '') {
    return { ok: false, reason: 'upstream', canFallback: true }
  }

  return { ok: true, prompt: (choice.content as string).trim() }
}

/**
 * Free models come and go weekly, so the fallback chain is DISCOVERED at
 * failure time rather than hardcoded to rot: the public model list, the free
 * ids, minus the one that just failed and the non-chat strays, in a stable
 * order, two tries at most. An empty result means no fallback, which lands
 * the visitor where they started — the retry button.
 */
const NON_CHAT = /(embed|rerank|guard|moderation|safety|omni|whisper|tts|image|video)/

async function discoverAlternateModels(failed: string): Promise<string[]> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return []
    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (payload.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string')
    return ids
      .filter((id) => id.endsWith(':free') && id !== failed && !NON_CHAT.test(id))
      .sort()
      .slice(0, 2)
  } catch {
    return []
  }
}

/**
 * The message array for one request. Pure, so the exact wording leaving the
 * backend is asserted by a test rather than reviewed by hope.
 */
export function buildMessages(finding: FixFinding): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: MASTER_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        siteUrl: finding.siteUrl ?? null,
        checkId: finding.checkId,
        pillar: finding.category,
        severity: finding.severity,
        title: finding.title,
        description: finding.description ?? null,
        evidence: finding.evidence ?? null,
        remediationHint: finding.remediation ?? null,
      }),
    },
  ]
}

/** A slow model is worse than a failed one: the UI has a retry button, not a patience test. */
const TIMEOUT_MS = 45_000

/**
 * One finding, one prompt: the configured model first, then — only on the
 * failures another model could survive — up to two live free alternates.
 *
 * Retries are still the CALLER's decision for the SAME model (the retry
 * button is a product behaviour, shown to a person); what changed is that a
 * single provider's bad moment no longer dead-ends the feature, because the
 * free tier's 5xx/429 storms are per-model, not per-account.
 */
export async function generateFix(finding: FixFinding): Promise<FixGeneration> {
  if (!serverEnv.fixesConfigured) return { ok: false, reason: 'unconfigured' }

  const primary = serverEnv.fixesModel || DEFAULT_MODEL
  const first = await attemptModel(primary, finding)
  if (first.ok) return first
  if (!first.canFallback) return { ok: false, reason: first.reason }

  let last: FixFailureReason = first.reason
  for (const model of await discoverAlternateModels(primary)) {
    const attempt = await attemptModel(model, finding)
    if (attempt.ok) return attempt
    if (!attempt.canFallback) return { ok: false, reason: attempt.reason }
    last = attempt.reason
  }
  return { ok: false, reason: last }
}

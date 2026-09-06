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
 * One completion, straight to OpenRouter. Retries are the CALLER's decision
 * (the retry button is a product behaviour, shown to a person) — a
 * service-side retry doubles the wait before the human sees the failure and
 * doubles the spend when the failure is a rejected key.
 */
export async function generateFix(finding: FixFinding): Promise<FixGeneration> {
  if (!serverEnv.fixesConfigured) return { ok: false, reason: 'unconfigured' }

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
        model: serverEnv.fixesModel || DEFAULT_MODEL,
        messages: buildMessages(finding),
        // A fix prompt is ~200 words; the ceiling exists so a runaway
        // completion becomes a failure, not a bill.
        max_tokens: 700,
        temperature: 0.2,
      }),
      signal: controller.signal,
    })
  } catch {
    return { ok: false, reason: 'network' }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    // Server-side log only: the visitor gets the generic sentence, the
    // operator gets the status and enough of the body to act on.
    console.error('openrouter refused', response.status, body.slice(0, 300))
    // The free tier throttles with 429; everything else (bad key, empty
    // credits, model down) is still worth one more press before giving up.
    if (response.status === 429) return { ok: false, reason: 'busy' }
    return { ok: false, reason: 'upstream' }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'upstream' }
  }

  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message
    ?.content
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, reason: 'upstream' }
  }

  return { ok: true, prompt: content.trim() }
}

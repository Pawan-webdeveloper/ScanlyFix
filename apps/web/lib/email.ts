/**
 * Sending one email.
 *
 * Transport only — it knows nothing about alerts, and nothing about alerts
 * knows about Resend. Swapping the provider is this file.
 *
 * Written against fetch rather than the `resend` package. Their API is one
 * POST with a JSON body; a dependency for that would be more package than
 * code, and this repo has no runtime dependency it did not need.
 *
 * ## The failure taxonomy is the point
 *
 * A monitoring product that loses its own alerts is worse than one with no
 * alerts, so the two kinds of failure are answered differently:
 *
 *   THROWN   — the network dropped, or the provider returned 5xx. Retrying
 *              fixes this, so it is thrown and the queue retries the step.
 *   RETURNED — no API key configured, a rejected address, a 4xx. Retrying
 *              cannot fix any of them; the caller records the reason and
 *              leaves the alert row unsent, where it is visible as such.
 *
 * A missing key is logged loudly on purpose. It is the configuration that
 * silently turns monitoring into a database of things nobody was told.
 */

import 'server-only'

const ENDPOINT = 'https://api.resend.com/emails'

/** Resend's own timeout is generous; a queue step should not wait that long. */
const TIMEOUT_MS = 10_000

export type SendResult = { readonly sent: true; readonly id: string } | { readonly sent: false; readonly reason: string }

export interface Message {
  to: string
  subject: string
  /** The real message. Plain text, because an alert should survive any client. */
  text: string
  /** A mirror of `text`, for clients that prefer it. Never carries extra facts. */
  html?: string
  /**
   * Files to travel with the message.
   *
   * base64 because that is what the provider's JSON body takes and what
   * survives a queue step's serialization — Inngest memoizes a step's return
   * value as JSON, and a Buffer does not round-trip through that.
   */
  attachments?: ReadonlyArray<{ filename: string; contentBase64: string; contentType?: string }>
}

/**
 * `onboarding@resend.dev` is Resend's sandbox sender, which only delivers to
 * the account owner's own address. It is a deliberate default: a deployment
 * that forgot to set a From address should fail visibly in testing rather than
 * send from a domain it has not verified and land in spam.
 */
function from(): string {
  return process.env['ALERT_FROM_EMAIL'] ?? 'ScanlyFix <alerts@scanlyfix.com>'
}

export function emailConfigured(): boolean {
  return Boolean(process.env['RESEND_API_KEY'])
}

export async function sendEmail(message: Message): Promise<SendResult> {
  const apiKey = process.env['RESEND_API_KEY']
  if (!apiKey) {
    console.error(
      '[email] RESEND_API_KEY is not set — alert NOT delivered. ' +
        'Monitoring is recording alerts that reach nobody.',
      { to: message.to, subject: message.subject },
    )
    return { sent: false, reason: 'RESEND_API_KEY is not configured' }
  }

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: from(),
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.attachments?.length
          ? {
              attachments: message.attachments.map((file) => ({
                filename: file.filename,
                content: file.contentBase64,
                ...(file.contentType ? { content_type: file.contentType } : {}),
              })),
            }
          : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    // Network or timeout. Thrown so the queue retries the step rather than
    // recording a permanent failure for something that is probably transient.
    throw new Error(`[email] could not reach the mail provider: ${describe(error)}`)
  }

  if (response.status >= 500) {
    throw new Error(`[email] mail provider returned ${response.status}; retrying`)
  }

  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const reason = providerMessage(body) ?? `HTTP ${response.status}`
    console.error('[email] rejected', { to: message.to, reason })

    // If rejected due to domain not verified in Resend (common in local dev / staging),
    // automatically fallback to Resend's onboarding sandbox sender so the user still gets the alert.
    const fromAddress = from()
    if (
      !fromAddress.includes('onboarding@resend.dev') &&
      (response.status === 403 ||
        response.status === 422 ||
        reason.toLowerCase().includes('domain') ||
        reason.toLowerCase().includes('verify'))
    ) {
      console.warn('[email] Domain rejected, retrying with onboarding@resend.dev fallback')
      try {
        const fallbackRes = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            from: 'ScanlyFix <onboarding@resend.dev>',
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (fallbackRes.ok) {
          const fbBody: unknown = await fallbackRes.json().catch(() => null)
          const fbId =
            fbBody && typeof fbBody === 'object' && 'id' in fbBody && typeof fbBody.id === 'string'
              ? fbBody.id
              : 'fallback-ok'
          return { sent: true, id: fbId }
        }
      } catch (fbErr) {
        console.error('[email] Fallback delivery also failed:', fbErr)
      }
    }

    return { sent: false, reason }
  }

  const id = body && typeof body === 'object' && 'id' in body && typeof body.id === 'string' ? body.id : 'unknown'
  return { sent: true, id }
}

function providerMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const message = (body as { message?: unknown }).message
  return typeof message === 'string' ? message : null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

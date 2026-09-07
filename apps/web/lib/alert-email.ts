/**
 * apps/web/lib/alert-email.ts
 *
 * Turning a recorded alert into a message somebody receives.
 *
 * Delivery takes an alert ID and an optional `ChannelRouting` and nothing
 * else. The row already carries the kind, the payload and the project, so
 * a send that failed can be retried later from an id alone — by the queue,
 * by a sweep, or by hand — without the job that raised it still being
 * around.
 *
 * `sentAt` is written only after the provider accepted the message. An alert
 * with a null `sentAt` is therefore exactly what it looks like: something the
 * customer was never told. That is the number worth watching in this product.
 *
 * The wording lives in alert-message.ts, which is pure and therefore testable
 * without a database or a mail provider. This file is the orchestration: look
 * it up, render it, send it, record that it went.
 *
 * Slack, Discord and generic webhook are secondary channels — their failure
 * never affects email delivery or the sentAt mark. Email remains the source
 * of truth for "was this sent" UNLESS the caller passes a routing that
 * suppresses it (per-monitor opt-out).
 */

import 'server-only'
import {
  alertForDelivery,
  markAlertSent,
  getAlertChannels,
  type WebhookChannelConfig,
} from '@scanlyfix/db'
import { render, renderSlack } from './alert-message.ts'
import { sendEmail, type SendResult } from './email.ts'
import { sendSlack } from './slack.ts'
import { sendDiscord, renderDiscord } from './discord.ts'
import { buildWebhookPayload, sendWebhook } from './webhook.ts'
import { resolveNotifyChannels, type ChannelRouting } from './alert-threshold.ts'
export { resolveNotifyChannels, type ChannelRouting } from './alert-threshold.ts'

// ─── HTML Helper ───────────────────────────────────────────────────────────────
/** A mirror of the text, never a second version of it with different facts. */
function asHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return (
    `<pre style="font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;` +
    `color:#0f1115;white-space:pre-wrap;margin:0">${escaped}</pre>`
  )
}

// ─── Shared types ─────────────────────────────────────────────────────────────
type AlertForDelivery = NonNullable<Awaited<ReturnType<typeof alertForDelivery>>>

/** One row from the internal getAlertChannels(projectId) overload. */
type AnyChannel = Awaited<ReturnType<typeof getAlertChannelsInternal>>[number]

/** Internal-only call — gives the full config, never the masked one. */
async function getAlertChannelsInternal(projectId: string) {
  return getAlertChannels(projectId)
}

// ─── Secondary channel dispatch ───────────────────────────────────────────────
// Each sender is given the FULL channel list for the project. It picks the
// row that matches its own kind, and (importantly) checks the per-alert
// allowlist before sending. The allowlist is the only mechanism that
// implements per-monitor channel routing — the sender cannot fan out to a
// channel the caller did not opt in to.

type ChannelSender = (
  channels: readonly AnyChannel[],
  alert: AlertForDelivery,
  /** Ids the caller is willing to dispatch to. */
  allowedIds: ReadonlySet<string>,
) => Promise<void>

// ─── Slack Delivery Helper ─────────────────────────────────────────────────────
/**
 * WHY separate function (not inline in deliverAlert):
 * - Clean separation — deliverAlert stays readable
 * - Easy to test Slack path in isolation
 *
 * WHY never throws:
 * - Email primary channel hai
 * - Slack failure = log karo, continue karo
 * - sentAt sirf email acceptance pe set hota hai
 */
const sendSlackChannel: ChannelSender = async (channels, alert, allowedIds) => {
  const channel = channels.find((c) => c.channel === 'slack' && c.enabled)
  if (!channel) return
  if (!allowedIds.has(channel.id)) return

  const webhookUrl = channel.config.webhookUrl
  if (typeof webhookUrl !== 'string') return

  const message = renderSlack(alert)
  const result = await sendSlack(webhookUrl, message)

  if (!result.sent) {
    console.warn(
      `[alert] Slack delivery failed for alert ${alert.id}: ${result.reason}`,
    )
  }
}

// ─── Discord Delivery Helper ───────────────────────────────────────────────────
const sendDiscordChannel: ChannelSender = async (channels, alert, allowedIds) => {
  const channel = channels.find((c) => c.channel === 'discord' && c.enabled)
  if (!channel) return
  if (!allowedIds.has(channel.id)) return

  const webhookUrl = channel.config.webhookUrl
  if (typeof webhookUrl !== 'string') return

  // Reuse the email render() for the body so the facts in the embed match
  // the facts in the email — there is exactly one source of truth for "what
  // happened".
  const { text } = render(alert)
  const message = renderDiscord({
    kind: alert.kind,
    projectName: alert.projectName,
    projectUrl: alert.projectUrl,
    text,
    payload: alert.payload,
  })

  const result = await sendDiscord(webhookUrl, message)
  if (!result.sent) {
    console.warn(
      `[alert] Discord delivery failed for alert ${alert.id}: ${result.reason}`,
    )
  }
}

// ─── Webhook Delivery Helper ───────────────────────────────────────────────────
/**
 * Generic webhook delivery — sends the standardized JSON payload to the
 * project's configured webhook URL (with optional HMAC signature).
 *
 * Same contract as the other secondary channels: never throws, never affects
 * the sentAt mark.
 */
const sendGenericWebhookChannel: ChannelSender = async (channels, alert, allowedIds) => {
  const channel = channels.find((c) => c.channel === 'webhook' && c.enabled)
  if (!channel) return
  if (!allowedIds.has(channel.id)) return

  const parseResult = parseWebhookConfig(channel.config)
  if (!parseResult.ok) {
    console.warn(
      `[alert] Webhook channel ${channel.id} has invalid config; skipping delivery for alert ${alert.id}`,
    )
    return
  }

  const payload = buildWebhookPayload({
    kind: alert.kind,
    projectName: alert.projectName,
    monitorType: 'uptime',
    url: alert.projectUrl,
    payload: alert.payload ?? {},
  })

  const result = await sendWebhook(parseResult.config, payload)
  if (!result.sent) {
    console.warn(
      `[alert] Webhook delivery failed for alert ${alert.id}: ${result.reason}`,
    )
  }
}

// Inline validator — keeps this file the single place that knows how the
// stored config is shaped.
function parseWebhookConfig(
  raw: unknown,
): { ok: true; config: WebhookChannelConfig } | { ok: false } {
  if (typeof raw !== 'object' || raw === null) return { ok: false }
  const obj = raw as Record<string, unknown>
  if (typeof obj.url !== 'string' || !obj.url.startsWith('https://')) {
    return { ok: false }
  }
  if (obj.secret !== undefined && typeof obj.secret !== 'string') {
    return { ok: false }
  }
  return { ok: true, config: obj as unknown as WebhookChannelConfig }
}

// Flat list of secondary senders — easy to extend with new channels.
const SECONDARY_CHANNELS: readonly ChannelSender[] = [
  sendSlackChannel,
  sendDiscordChannel,
  sendGenericWebhookChannel,
]

// ─── Main Delivery ─────────────────────────────────────────────────────────────

/**
 * Deliver an alert. The `routing` argument is the result of calling
 * `resolveNotifyChannels(alertConfig, enabledChannelIds)` — if omitted, the
 * function falls back to "send to every enabled channel" (the
 * backward-compatible default).
 *
 * Returns the email-send result regardless of secondary outcomes, since
 * `sentAt` is the source of truth for "did the customer hear about this".
 * When `routing.sendEmail` is false, the function returns
 * `{ sent: true, reason: 'email suppressed by routing' }` so the caller can
 * still treat the alert as delivered.
 */
export async function deliverAlert(
  alertId: string,
  routing?: ChannelRouting,
): Promise<SendResult> {
  const alert = await alertForDelivery(alertId)
  if (!alert) return { sent: false, reason: 'alert no longer exists' }

  // Belt and braces against a step re-running after the mark. recordAlertOnce
  // already stops a second alert being raised; this stops a second send of the
  // same one.
  if (alert.sentAt) return { sent: false, reason: 'already delivered' }

  const { subject, text } = render(alert)

  // Read all channels for the project. Used both to drive the secondary
  // fan-out AND to derive the "all enabled" default when no routing is passed.
  const channels = await getAlertChannelsInternal(alert.projectId)
  const enabledChannelIds = channels.filter((c) => c.enabled).map((c) => c.id)
  const effectiveRouting: ChannelRouting =
    routing ?? resolveNotifyChannels(null, enabledChannelIds)

  // ── Primary: Email ─────────────────────────────────────────────────────────
  // The email is suppressed when the caller asked us to (per-monitor
  // notifyChannels is non-empty). When suppressed, we still mark the row
  // sent — the customer heard about it via the configured channels.
  //
  // Per-monitor alertEmail: if the alert payload carries an alertEmail override
  // (set by uptime-probe from alertConfig.alertEmail), deliver to that address
  // instead of the project owner's default email. This allows users to route
  // alerts for a specific monitor to a different inbox (e.g. an ops alias).
  const payloadAlertEmail =
    alert.payload &&
    typeof alert.payload === 'object' &&
    'alertEmail' in alert.payload &&
    typeof alert.payload.alertEmail === 'string' &&
    alert.payload.alertEmail.includes('@')
      ? alert.payload.alertEmail
      : null
  const toEmail = payloadAlertEmail ?? alert.recipientEmail

  let result: SendResult
  if (effectiveRouting.sendEmail) {
    result = await sendEmail({
      to: toEmail,
      subject,
      text,
      html: asHtml(text),
    })
    if (result.sent) await markAlertSent(alert.id)
  } else {
    // The user opted this alert out of email. Treat the alert as delivered
    // so it does not show up as an unhandled undelivered row — the routing
    // IS the delivery for this monitor.
    await markAlertSent(alert.id)
    // Note: SendResult.sent:true carries no `reason` — we mark the row
    // ourselves above and return a minimal success. The caller's only use
    // of this is `result.sent` to drive its own logic.
    result = { sent: true, id: 'email-suppressed' }
  }

  // ── Secondary channels ─────────────────────────────────────────────────────
  // WHY after email + markAlertSent:
  //  1. Email is primary — its success/failure is what matters
  //  2. sentAt mark should not be blocked by secondary channels
  //  3. Secondary channel failure never changes what we return to caller
  //
  // WHY await (not void/fire-and-forget):
  //  In Inngest step.run, the step completes after this function returns.
  //  fire-and-forget = secondary sends might not finish before step ends.
  //  Awaiting = controlled, logged, reliable.
  //
  // WHY parallel: each channel is independent, and they all need to complete
  // before the Inngest step does. A failure in one must not stop the others.
  const allowedSet = new Set(effectiveRouting.secondaryChannelIds)
  const results = await Promise.allSettled(
    SECONDARY_CHANNELS.map((send) => send(channels, alert, allowedSet)),
  )
  for (const r of results) {
    if (r.status === 'rejected') {
      // Senders are wrapped in try/catch internally, so this should not
      // happen — but if it does, log and move on. Email is already sent.
      console.error(`[alert] Secondary channel threw unexpectedly:`, r.reason)
    }
  }

  return result
}

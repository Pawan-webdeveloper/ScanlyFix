/**
 * Turning a recorded alert into the words somebody reads.
 *
 * Pure, and kept out of alert-email.ts for the same reason billing-period.ts is
 * kept out of quota.ts: that file reaches the database and a mail provider,
 * and this is string formatting. Split, it can be tested without either — and
 * this is where the bugs actually live, because every input is a jsonb blob
 * whose shape nothing enforces.
 *
 * `alerts.kind` is text rather than an enum precisely so a new alert can ship
 * without a migration, which means render() will one day be handed a kind it
 * has never seen. It answers with a generic message rather than null: less
 * useful than a tailored one, infinitely more useful than silence.
 *
 * The prose is deliberately plain and specific. An alert is read at 3am on a
 * phone, and the reader needs the host, what happened, and one link. Anything
 * else in it is something to scroll past.
 */

import 'server-only'
import { serverEnv } from './env.ts'
import type { SlackMessage } from './slack.ts'

export interface AlertSubject {
  kind: string
  payload: Record<string, unknown> | null
  projectName: string
  projectUrl: string
  projectSlug: string
}

export interface Rendered {
  subject: string
  text: string
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function num(payload: Record<string, unknown> | null, key: string): number | null {
  const value = payload?.[key]
  return typeof value === 'number' ? value : null
}

function str(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key]
  return typeof value === 'string' ? value : null
}

function bool(payload: Record<string, unknown> | null, key: string): boolean {
  return payload?.[key] === true
}

/**
 * One renderer per kind, and a fallback that still says something true.
 *
 * `alerts.kind` is text rather than an enum precisely so a new alert can ship
 * without a migration — which means this function will one day be handed a
 * kind it has never seen. Returning null there would silently drop a real
 * alert, so it renders a generic one instead: less useful than a tailored
 * message, infinitely more useful than silence.
 */
export function render(alert: AlertSubject): Rendered {
  const host = hostOf(alert.projectUrl)
  const app = serverEnv.appUrl
  const status = `${app}/status/${alert.projectSlug}`

  if (alert.kind === 'downtime') {
    const streak = num(alert.payload, 'streak') ?? 0
    const code = num(alert.payload, 'statusCode')
    const detail = str(alert.payload, 'detail')
    const latency = num(alert.payload, 'latencyMs')
    const observed = code !== null ? `HTTP ${code}` : (detail ?? 'no response')

    const observedBlock: string[] = [`Observed: ${observed}`]
    if (code !== null && code >= 500) {
      // WHY call this out: a 5xx is almost always a server problem and
      // worth a separate line the reader can act on without parsing prose.
      observedBlock.push(`The server returned a 5xx error (code ${code}).`)
    } else if (code !== null && code >= 400 && code < 500) {
      observedBlock.push(`The server returned a 4xx error (code ${code}).`)
    } else if (code === null) {
      observedBlock.push(`No HTTP response was received.`)
    }
    if (latency !== null && latency > 0) {
      observedBlock.push(`Last response latency: ${latency}ms`)
    }

    return {
      subject: code !== null
        ? `[DOWN] ${host} — HTTP ${code}`
        : `${host} is not responding`,
      text: lines([
        `${host} has failed ${streak} consecutive checks.`,
        '',
        ...observedBlock,
        `Checked:  ${alert.projectUrl}`,
        '',
        `Status page: ${status}`,
        '',
        'You will not be emailed again about this today, however long it lasts.',
      ]),
    }
  }

  if (alert.kind === 'recovered') {
    const downFor = str(alert.payload, 'downFor') ?? 'unknown duration'
    const recoveredAt = str(alert.payload, 'recoveredAt')
    const incidentId = str(alert.payload, 'incidentId')

    const recoveredTime = recoveredAt
      ? `at ${new Date(recoveredAt).toUTCString()}`
      : 'just now'

    return {
      subject: `[RESOLVED] ${host} is back up (was down ${downFor})`,
      text: lines([
        `${host} is back up and responding normally.`,
        '',
        `Was down for: ${downFor}`,
        `Recovered: ${recoveredTime}`,
        '',
        `Checked: ${alert.projectUrl}`,
        `Status page: ${status}`,
        '',
        incidentId ? `Incident: ${status}?incident=${incidentId}` : null,
      ].filter((l): l is string => l !== null)),
    }
  }

  if (alert.kind === 'downtime-reminder') {
    const streak = num(alert.payload, 'streak') ?? 0
    const code = num(alert.payload, 'statusCode')
    const detail = str(alert.payload, 'detail')
    const downFor = str(alert.payload, 'downFor') ?? 'unknown duration'
    const reminderNumber = num(alert.payload, 'reminderNumber') ?? 1
    const latency = num(alert.payload, 'latencyMs')
    const observed = code !== null ? `HTTP ${code}` : (detail ?? 'no response')

    return {
      subject: code !== null
        ? `[STILL DOWN] ${host} — HTTP ${code} — down for ${downFor}`
        : `[STILL DOWN] ${host} — down for ${downFor} (reminder #${reminderNumber})`,
      text: lines([
        `${host} is still down after ${downFor}.`,
        '',
        `This is reminder #${reminderNumber}.`,
        `Last observed: ${observed}`,
        latency !== null && latency > 0 ? `Last response latency: ${latency}ms` : null,
        `Checked: ${alert.projectUrl}`,
        '',
        `Status page: ${status}`,
        '',
        'The site has not recovered since the initial downtime alert.',
        'You will continue to receive reminders until the site comes back up.',
      ].filter((l): l is string => l !== null)),
    }
  }

  if (alert.kind === 'tls_expiring') {
    const days = num(alert.payload, 'daysUntilExpiry')
    const expiresAt = str(alert.payload, 'expiresAt')
    const subject_ = str(alert.payload, 'subject')
    const urgent = bool(alert.payload, 'urgent')
    const expired = days !== null && days <= 0

    const expirySummary = expiresAt
      ? `Expiry date: ${new Date(expiresAt).toDateString()}`
      : null

    return {
      subject: expired
        ? `${host} — TLS certificate has expired`
        : urgent
          ? `${host} — TLS certificate expires in ${days} days`
          : `${host} — TLS certificate expires in ${days} days`,
      text: lines([
        expired
          ? `The TLS certificate for ${host} has expired. Visitors are seeing a browser warning instead of the site.`
          : `The TLS certificate for ${host} expires in ${days} day${days === 1 ? '' : 's'}.`,
        '',
        subject_ ? `Certificate issued for: ${subject_}` : null,
        expirySummary,
        '',
        'If renewal is automated, confirm it ran. If it is not, renew it now.',
        '',
        `Site:        ${alert.projectUrl}`,
        `Status page: ${status}`,
        '',
        urgent || expired
          ? 'This is urgent — browsers block sites with expired certificates.'
          : 'You have time, but less than two weeks.',
      ].filter((l): l is string => l !== null)),
    }
  }

  if (alert.kind === 'domain_expiring') {
    const days = num(alert.payload, 'daysUntilExpiry')
    const expiresAt = str(alert.payload, 'expiresAt')
    const registrar = str(alert.payload, 'registrar')
    const urgent = bool(alert.payload, 'urgent')
    const expired = days !== null && days <= 0

    const expirySummary = expiresAt
      ? `Expiry date: ${new Date(expiresAt).toDateString()}`
      : null

    return {
      subject: expired
        ? `${host} — domain registration has expired`
        : urgent
          ? `${host} — domain expires in ${days} days`
          : `${host} — domain expires in ${days} days`,
      text: lines([
        expired
          ? `The domain registration for ${host} has expired. The site may stop resolving for visitors.`
          : `The domain registration for ${host} expires in ${days} day${days === 1 ? '' : 's'}.`,
        '',
        registrar ? `Registrar:   ${registrar}` : null,
        expirySummary,
        '',
        'Log in to your registrar and renew before it lapses. A lapsed domain',
        'can be claimed by someone else and is difficult and expensive to recover.',
        '',
        `Site:        ${alert.projectUrl}`,
        `Status page: ${status}`,
        '',
        urgent || expired
          ? 'This is urgent — act today.'
          : 'You have time, but renewal takes a few minutes and forgetting it does not.',
      ].filter((l): l is string => l !== null)),
    }
  }

  if (alert.kind.startsWith('certificate-expiry')) {
    const daysLeft = num(alert.payload, 'daysLeft')
    const expired = daysLeft !== null && daysLeft < 0
    const expiresAt = str(alert.payload, 'expiresAt')
    const subject_ = str(alert.payload, 'subject')

    const expirySummary = expiresAt
      ? `Expiry date: ${new Date(expiresAt).toDateString()}`
      : null

    return {
      subject: expired
        ? `${host} has an expired TLS certificate`
        : `${host} certificate expires in ${daysLeft} days`,
      text: lines([
        expired
          ? `The TLS certificate for ${host} has expired. Browsers are showing a warning instead of the site.`
          : `The TLS certificate for ${host} expires in ${daysLeft} days.`,
        '',
        subject_ ? `Certificate issued for: ${subject_}` : null,
        expirySummary,
        '',
        'If renewal is automated, confirm it ran. If it is not, this is the reminder.',
        '',
        `Site: ${alert.projectUrl}`,
        `Status page: ${status}`,
      ].filter((l): l is string => l !== null)),
    }
  }

  if (alert.kind.startsWith('domain-expiry')) {
    const daysLeft = num(alert.payload, 'daysLeft')
    const expired = daysLeft !== null && daysLeft < 0
    const expiresAt = str(alert.payload, 'expiresAt')
    const registrar = str(alert.payload, 'registrar')
    const urgent = bool(alert.payload, 'urgent')

    const expirySummary = expiresAt
      ? `Expiry date: ${new Date(expiresAt).toDateString()}`
      : null

    return {
      subject: expired
        ? `${host} — domain registration has expired`
        : urgent
          ? `${host} — domain expires in ${daysLeft} days`
          : `${host} — domain expires in ${daysLeft} days`,
      text: lines([
        expired
          ? `The domain registration for ${host} has expired. The site may stop resolving for visitors.`
          : `The domain registration for ${host} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
        '',
        registrar ? `Registrar:   ${registrar}` : null,
        expirySummary,
        '',
        'Log in to your registrar and renew before it lapses. A lapsed domain',
        'can be claimed by someone else and is difficult and expensive to recover.',
        '',
        `Site:        ${alert.projectUrl}`,
        `Status page: ${status}`,
        '',
        urgent || expired
          ? 'This is urgent — act today.'
          : 'You have time, but renewal takes a few minutes and forgetting it does not.',
      ].filter((l): l is string => l !== null)),
    }
  }

  // ─── ADD: DNS Drift Alert ─────────────────────────────────────────────────────
if (alert.kind === 'dns_drift') {
  // WHY type assertion with fallback: payload jsonb se aata hai — safely handle karo
  const added =
    (alert.payload?.added as Array<{ type: string; value: string }> | undefined) ?? []
  const removed =
    (alert.payload?.removed as Array<{ type: string; value: string }> | undefined) ?? []
  const hostname = (alert.payload?.hostname as string | undefined) ?? host

  const addedLines = added.map((r) => `  + ${r.type.padEnd(5)} ${r.value}`)
  const removedLines = removed.map((r) => `  - ${r.type.padEnd(5)} ${r.value}`)

  return {
    subject: `⚠️ DNS records changed — ${hostname}`,
    text: [
      `DNS records for ${hostname} have changed.`,
      '',
      ...(removed.length > 0 ? ['Records removed:', ...removedLines, ''] : []),
      ...(added.length > 0 ? ['Records added:', ...addedLines, ''] : []),
      `Monitor: ${alert.projectUrl}`,
      `Status:  ${status}`,
      '',
      'If this change was expected (CDN switch, migration), no action needed.',
      'If unexpected — check your DNS provider immediately.',
    ].join('\n'),
  }
}


// Existing if/switch chain mein ADD karo:
if (alert.kind === 'web_vitals') {
  const violations =
    (alert.payload?.violations as Array<{
      metric: string
      value: number
      unit: string
      severity: 'warn' | 'critical'
    }> | undefined) ?? []

  const hasCritical = alert.payload?.hasCritical as boolean | undefined

  const lines = violations.map(
    (v) =>
      `  ${v.severity === 'critical' ? '🔴' : '🟡'} ${v.metric}: ${v.value}${v.unit}`,
  )

  return {
    subject: `${hasCritical ? '🔴' : '🟡'} Web Vitals alert — ${alert.payload?.url}`,
    text: [
      `Core Web Vitals thresholds crossed for:`,
      `${alert.payload?.url}`,
      '',
      ...lines,
      '',
      `Monitor: ${alert.projectUrl}`,
      '',
      'Slow vitals directly impact user experience and SEO rankings.',
      'Check your hosting, images, and third-party scripts.',
    ].join('\n'),
  }
}

  if (alert.kind === 'score-drop') {
    const before = num(alert.payload, 'before')
    const after = num(alert.payload, 'after')
    const scanId = str(alert.payload, 'scanId')
    const drop = before !== null && after !== null ? before - after : null

    return {
      subject: `${host} dropped ${drop ?? 'several'} points`,
      text: lines([
        `${host} scored ${after} on today's scan, down from ${before}.`,
        '',
        'Both scans were run by the same engine version with no degraded pillars,',
        'so this is a change on the site rather than a change in what we measure.',
        '',
        scanId ? `Report: ${app}/scan/${scanId}` : `Project: ${app}/projects`,
      ]),
    }
  }

  return {
    subject: `${host}: ${alert.kind.replace(/[-_]/g, ' ')}`,
    text: lines([
      `ScanlyFix raised a "${alert.kind}" alert for ${alert.projectName}.`,
      '',
      `Site: ${alert.projectUrl}`,
      `Status page: ${status}`,
    ]),
  }
}

function lines(parts: readonly string[]): string {
  return parts.join('\n')
}

// ─── Slack Renderer ────────────────────────────────────────────────────────────
/**
 * Converts an alert into a Slack Block Kit message.
 *
 * WHY separate from render():
 *  - Slack Block Kit has strict type constraints (section, divider, header, context)
 *  - Text length limits differ (3000 chars max per block)
 *  - Fallback `text` field is required for desktop/mobile notifications
 *
 * Same robustness as render(): unknown kinds produce a usable message,
 * not silence.
 */
export function renderSlack(alert: AlertSubject): SlackMessage {
  const { subject, text } = render(alert)

  // Slack text field has a 3000 char limit — truncate if needed
  const truncatedText = text.length > 3000 ? text.slice(0, 2997) + '...' : text

  return {
    text: subject,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: subject },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: truncatedText },
      },
    ],
  }
}
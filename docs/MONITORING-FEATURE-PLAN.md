# Monitoring Feature — Complete Implementation Plan

## Current State Analysis

### What Already Works

| Feature | Status | Implementation |
|---|---|---|
| 60s uptime check | ✅ | `uptime-probe.ts` — safeFetch with 15s timeout |
| Incident tracking | ✅ | `incidents` table + `createIncident()` / `resolveIncident()` |
| Down/recovered email | ✅ | `alert-email.ts` via Resend API |
| Domain expiry | ✅ | `domain-checker.ts` via RDAP |
| SSL expiry | ✅ | `ssl-checker.ts` via TLS handshake |
| Public status page | ✅ | `getPublicStatus()` query + `/status/[slug]` page |
| 90-day history | ✅ | `monitor_events` table + daily buckets |
| Scheduled re-scans | ✅ | Inngest cron → `sweep.ts` → `uptime-probe.ts` |

### Missing Features (7 items to build)

| # | Feature | Complexity | Files to Touch |
|---|---|---|---|
| 1 | DNS drift detection | Medium | `packages/checks/src/dns-checker.ts` (new), `schema.ts`, `monitoring-probe.ts` |
| 2 | What-changed diff view | Medium | `packages/db/src/queries/monitors.ts`, API route, frontend component |
| 3 | Core Web Vitals alerts | Medium | `packages/checks/src/performance/web-vitals.ts` (new), `schema.ts`, alerts |
| 4 | Slack webhook | Low | `apps/web/lib/slack.ts` (new), `alert-email.ts`, `schema.ts` |
| 5 | On-deploy trigger | Low | New API route + Inngest event emit |
| 6 | Severity threshold | Low | `schema.ts`, `uptime-probe.ts`, frontend toggle |
| 7 | Snooze rules | Low | `schema.ts`, API route, `uptime-probe.ts` guard |

---

## Feature 1: DNS Drift Detection

### What
Alert when a domain's DNS records (A, CNAME, NS) change from what was last recorded. Catches unauthorized DNS changes, CDN switches, or accidental misconfigurations.

### Why
A DNS change can take a site down silently — the uptime check still passes (IP responds) but traffic routes to the wrong server. Current monitoring only checks HTTP status, not DNS correctness.

### Database Changes

**File: `packages/db/src/schema.ts`**

Add new table after `monitorEvents`:

```typescript
export const dnsSnapshots = pgTable(
  'dns_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    /** JSON array of resolved records: [{type:'A', value:'1.2.3.4'}, ...] */
    records: jsonb('records').$type<Array<{ type: string; value: string }>>().notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dns_snapshots_monitor_ts_idx').on(t.monitorId, desc(t.ts))],
)
```

Add to `monitorTypeEnum`: `'dns'` (alongside existing `'uptime'` | `'domain'`).

Add relation:
```typescript
export const dnsSnapshotsRelations = relations(dnsSnapshots, ({ one }) => ({
  monitor: one(monitors, { fields: [dnsSnapshots.monitorId], references: [monitors.id] }),
}))
```

### Checker Implementation

**File: `packages/checks/src/dns-checker.ts` (NEW)**

```typescript
import { resolve4, resolveCname, resolveNs } from 'node:dns/promises'

export interface DnsRecord {
  type: 'A' | 'CNAME' | 'NS'
  value: string
}

export interface DnsCheckResult {
  ok: boolean
  records: DnsRecord[]
  changed: boolean
  added: DnsRecord[]
  removed: DnsRecord[]
  detail: string | null
}

export async function checkDns(hostname: string): Promise<DnsCheckResult> {
  const records: DnsRecord[] = []

  try {
    // A records
    const aRecords = await resolve4(hostname)
    for (const a of aRecords) records.push({ type: 'A', value: a })

    // CNAME records
    try {
      const cnameRecords = await resolveCname(hostname)
      for (const c of cnameRecords) records.push({ type: 'CNAME', value: c })
    } catch { /* no CNAME — normal for apex domains */ }

    // NS records (check parent domain)
    const parts = hostname.split('.')
    const domain = parts.length >= 2 ? parts.slice(-2).join('.') : hostname
    try {
      const nsRecords = await resolveNs(domain)
      for (const ns of nsRecords) records.push({ type: 'NS', value: ns })
    } catch { /* NS lookup failed — non-fatal */ }

    return { ok: true, records, changed: false, added: [], removed: [], detail: null }
  } catch (err) {
    return {
      ok: false,
      records: [],
      changed: false,
      added: [],
      removed: [],
      detail: err instanceof Error ? err.message : 'DNS lookup failed',
    }
  }
}

/**
 * Compare current records against previous snapshot.
 * Returns which records were added/removed.
 */
export function diffDnsRecords(
  previous: DnsRecord[],
  current: DnsRecord[],
): { added: DnsRecord[]; removed: DnsRecord[]; changed: boolean } {
  const prevSet = new Set(previous.map((r) => `${r.type}:${r.value}`))
  const currSet = new Set(current.map((r) => `${r.type}:${r.value}`))

  const added = current.filter((r) => !prevSet.has(`${r.type}:${r.value}`))
  const removed = previous.filter((r) => !currSet.has(`${r.type}:${r.value}`))

  return { added, removed, changed: added.length > 0 || removed.length > 0 }
}
```

### Integration into Monitor Flow

**File: `packages/db/src/queries/monitors.ts`**

Add new functions:

```typescript
export async function getLatestDnsSnapshot(monitorId: string): Promise<DnsRecord[] | null> {
  const latest = await db.query.dnsSnapshots.findFirst({
    where: eq(dnsSnapshots.monitorId, monitorId),
    orderBy: desc(dnsSnapshots.ts),
    columns: { records: true },
  })
  return latest?.records ?? null
}

export async function recordDnsSnapshot(
  monitorId: string,
  records: DnsRecord[],
): Promise<void> {
  await db.insert(dnsSnapshots).values({ monitorId, records })
}
```

**File: `apps/web/inngest/functions/monitoring-probe.ts`**

Add DNS check to the existing monitoring probe:

```typescript
import { checkDns, diffDnsRecords } from '@scanlyfix/checks'

// Inside the probe function, after SSL/domain checks:
if (monitor.type === 'domain') {
  const dns = await checkDns(hostname)
  if (dns.ok) {
    const previous = await getLatestDnsSnapshot(monitor.id)
    if (previous) {
      const diff = diffDnsRecords(previous, dns.records)
      if (diff.changed) {
        // Alert: DNS drift detected
        await recordAlertOnce({
          projectId,
          kind: 'dns_drift',
          channel: 'email',
          payload: {
            hostname,
            added: diff.added,
            removed: diff.removed,
          },
        })
      }
    }
    await recordDnsSnapshot(monitor.id, dns.records)
  }
}
```

### Alert Message

**File: `apps/web/lib/alert-message.ts`**

Add new handler:

```typescript
if (alert.kind === 'dns_drift') {
  const added = (alert.payload?.added as Array<{ type: string; value: string }>) ?? []
  const removed = (alert.payload?.removed as Array<{ type: string; value: string }>) ?? []

  return {
    subject: `${host} — DNS records changed`,
    text: lines([
      `DNS records for ${host} have changed.`,
      '',
      added.length > 0
        ? `Added:\n${added.map((r) => `  + ${r.type} ${r.value}`).join('\n')}`
        : null,
      removed.length > 0
        ? `Removed:\n${removed.map((r) => `  - ${r.type} ${r.value}`).join('\n')}`
        : null,
      '',
      `Site:        ${alert.projectUrl}`,
      `Status page: ${status}`,
      '',
      'If this change was expected (CDN switch, migration), no action needed.',
      'If not, check your DNS provider immediately.',
    ].filter((l): l is string => l !== null)),
  }
}
```

### Migration

```bash
cd packages/db
pnpm db:generate
pnpm db:migrate
```

---

## Feature 2: What-Changed Diff View

### What
When a monitor event occurs, show exactly what changed compared to the previous check: status code, latency delta, response headers, etc.

### Why
A user seeing "DOWN" needs to know: was it a 500? A timeout? A DNS failure? The diff view answers "what is different now vs. the last good check."

### Database Changes

**File: `packages/db/src/schema.ts`**

Add column to `monitorEvents`:

```typescript
/** JSON diff of what changed from the previous check. null for first-ever event. */
diff: jsonb('diff').$type<{
  statusCode?: { from: number | null; to: number | null }
  latencyMs?: { from: number | null; to: number | null }
  detail?: { from: string | null; to: string | null }
}>(),
```

### Query Changes

**File: `packages/db/src/queries/monitors.ts`**

Add function:

```typescript
export async function recentEventsWithDiff(
  monitorId: string,
  viewer: Viewer,
  limit = 50,
): Promise<Array<MonitorEvent & { diff: Record<string, unknown> | null }>> {
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { projectId: true },
  })
  if (!monitor || !(await getProject(monitor.projectId, viewer))) return []

  // Fetch events with previous event for diff
  const events = await db.query.monitorEvents.findMany({
    where: eq(monitorEvents.monitorId, monitorId),
    orderBy: desc(monitorEvents.ts),
    limit: limit + 1, // +1 to get previous for diff
  })

  // Compute diffs
  const eventsWithDiff = events.map((event, i) => {
    const prev = events[i + 1] // next in array = previous in time
    const diff = prev
      ? {
          statusCode: { from: prev.statusCode, to: event.statusCode },
          latencyMs: { from: prev.latencyMs, to: event.latencyMs },
          detail: { from: prev.detail, to: event.detail },
        }
      : null
    return { ...event, diff }
  })

  // Remove the extra event (the +1 we fetched for diff calculation)
  return eventsWithDiff.slice(0, limit)
}
```

### API Changes

**File: `apps/web/app/api/monitors/[id]/logs/route.ts`**

Update to use `recentEventsWithDiff`:

```typescript
import { recentEventsWithDiff } from '@scanlyfix/db'

// In the GET handler:
const events = await recentEventsWithDiff(id, viewer, 100)
return NextResponse.json({ logs: events })
```

### Frontend Component

**File: `apps/web/components/monitors/monitor-detail.tsx`**

Add diff display to the response time chart section:

```tsx
{logs.map((log, i) => (
  <div key={i} className="...">
    <StatusDot status={log.ok ? 'up' : 'down'} />
    <span>{log.statusCode}</span>
    <span>{log.latencyMs}ms</span>
    {log.diff && (
      <span className="text-xs text-amber-600">
        Changed: {log.diff.statusCode?.from} → {log.diff.statusCode?.to}
      </span>
    )}
  </div>
))}
```

---

## Feature 3: Core Web Vitals Alerts

### What
Monitor LCP, FID, CLS via Google PageSpeed Insights (PSI) API. Alert when any metric crosses a threshold.

### Why
Uptime checks confirm the site is "alive." Web Vitals confirm the site is "fast." A site can return 200 but take 8 seconds to load — the uptime check passes, but users leave.

### Database Changes

**File: `packages/db/src/schema.ts`**

Add new table:

```typescript
export const webVitalsSnapshots = pgTable(
  'web_vitals_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    lcp: integer('lcp_ms'),          // Largest Contentful Paint (ms)
    fid: integer('fid_ms'),          // First Input Delay (ms)
    cls: real('cls'),                 // Cumulative Layout Shift (0-1)
    fcp: integer('fcp_ms'),          // First Contentful Paint (ms)
    ttfb: integer('ttfb_ms'),        // Time to First Byte (ms)
    si: integer('si_ms'),            // Speed Index (ms)
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('web_vitals_monitor_ts_idx').on(t.monitorId, desc(t.ts))],
)
```

Add to `monitorTypeEnum`: `'web_vitals'`.

### Checker Implementation

**File: `packages/checks/src/performance/web-vitals.ts` (NEW)**

```typescript
export interface WebVitalsResult {
  ok: boolean
  lcp: number | null
  fid: number | null
  cls: number | null
  fcp: number | null
  ttfb: number | null
  si: number | null
  detail: string | null
}

/**
 * Uses PageSpeed Insights API (free tier: 25k requests/month).
 * Requires PSI_API_KEY env var (optional — works without key but rate-limited).
 */
export async function checkWebVitals(url: string): Promise<WebVitalsResult> {
  const apiKey = process.env.PSI_API_KEY ?? ''
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile${apiKey ? `&key=${apiKey}` : ''}`

  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) {
      return { ok: false, lcp: null, fid: null, cls: null, fcp: null, ttfb: null, si: null, detail: `PSI API error: ${res.status}` }
    }

    const data = await res.json() as {
      lighthouseResult?: {
        audits?: {
          'largest-contentful-paint'?: { numericValue?: number }
          'first-input-delay'?: { numericValue?: number }
          'cumulative-layout-shift'?: { numericValue?: number }
          'first-contentful-paint'?: { numericValue?: number }
          'server-response-time'?: { numericValue?: number }
          'speed-index'?: { numericValue?: number }
        }
      }
    }

    const audits = data.lighthouseResult?.audits ?? {}

    return {
      ok: true,
      lcp: audits['largest-contentful-paint']?.numericValue ?? null,
      fid: audits['first-input-delay']?.numericValue ?? null,
      cls: audits['cumulative-layout-shift']?.numericValue ?? null,
      fcp: audits['first-contentful-paint']?.numericValue ?? null,
      ttfb: audits['server-response-time']?.numericValue ?? null,
      si: audits['speed-index']?.numericValue ?? null,
      detail: null,
    }
  } catch (err) {
    return {
      ok: false,
      lcp: null, fid: null, cls: null, fcp: null, ttfb: null, si: null,
      detail: err instanceof Error ? err.message : 'PSI request failed',
    }
  }
}
```

### Alert Thresholds

**File: `apps/web/lib/web-vitals-thresholds.ts` (NEW)**

```typescript
export interface VitalThreshold {
  metric: string
  warn: number
  critical: number
  unit: string
}

export const THRESHOLDS: Record<string, VitalThreshold> = {
  lcp:  { metric: 'LCP',  warn: 2500, critical: 4000, unit: 'ms' },
  fid:  { metric: 'FID',  warn: 100,  critical: 300,  unit: 'ms' },
  cls:  { metric: 'CLS',  warn: 0.1,  critical: 0.25, unit: '' },
  fcp:  { metric: 'FCP',  warn: 1800, critical: 3000, unit: 'ms' },
  ttfb: { metric: 'TTFB', warn: 800,  critical: 1800, unit: 'ms' },
  si:   { metric: 'SI',   warn: 3400, critical: 5800, unit: 'ms' },
}

export function evaluateVitals(vitals: Record<string, number | null>): {
  violations: Array<{ metric: string; value: number; severity: 'warn' | 'critical' }>
} {
  const violations: Array<{ metric: string; value: number; severity: 'warn' | 'critical' }> = []

  for (const [key, threshold] of Object.entries(THRESHOLDS)) {
    const value = vitals[key]
    if (value === null || value === undefined) continue

    if (value >= threshold.critical) {
      violations.push({ metric: threshold.metric, value, severity: 'critical' })
    } else if (value >= threshold.warn) {
      violations.push({ metric: threshold.metric, value, severity: 'warn' })
    }
  }

  return { violations }
}
```

### Integration

**File: `apps/web/inngest/functions/monitoring-probe.ts`**

Add web vitals check for monitors with type `web_vitals`:

```typescript
import { checkWebVitals } from '@scanlyfix/checks'
import { evaluateVitals } from '@/lib/web-vitals-thresholds.ts'

if (monitor.type === 'web_vitals') {
  const vitals = await checkWebVitals(url)
  if (vitals.ok) {
    // Save snapshot
    await db.insert(webVitalsSnapshots).values({
      monitorId: monitor.id,
      lcp: vitals.lcp,
      fid: vitals.fid,
      cls: vitals.cls,
      fcp: vitals.fcp,
      ttfb: vitals.ttfb,
      si: vitals.si,
    })

    // Check thresholds
    const { violations } = evaluateVitals({
      lcp: vitals.lcp,
      fid: vitals.fid,
      cls: vitals.cls,
      fcp: vitals.fcp,
      ttfb: vitals.ttfb,
      si: vitals.si,
    })

    if (violations.length > 0) {
      await recordAlertOnce({
        projectId,
        kind: 'web_vitals',
        channel: 'email',
        payload: { url, violations },
      })
    }
  }
}
```

---

## Feature 4: Slack Webhook

### What
Send alerts to Slack via incoming webhook URL, in addition to email.

### Why
Teams that use Slack don't check email for alerts. A webhook delivers alerts to the channel where work happens.

### Database Changes

**File: `packages/db/src/schema.ts`**

Add to `alertChannelEnum`: `'slack'` (alongside existing `'email'`).

Add column to `projects` table (or a new `alert_config` table):

```typescript
/** Slack incoming webhook URL. null = no Slack alerts. */
slackWebhookUrl: text('slack_webhook_url'),
```

Or better — create a dedicated config table:

```typescript
export const alertChannels = pgTable('alert_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  channel: alertChannelEnum('channel').notNull(),
  /** Slack webhook URL, email address, etc. Stored as encrypted JSON. */
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

### Slack Sender

**File: `apps/web/lib/slack.ts` (NEW)**

```typescript
import 'server-only'

export interface SlackMessage {
  text: string
  blocks?: Array<{
    type: string
    text?: { type: string; text: string }
  }>
}

export async function sendSlack(
  webhookUrl: string,
  message: SlackMessage,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      return { sent: false, reason: `Slack API error: ${res.status}` }
    }
    return { sent: true }
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : 'Slack request failed' }
  }
}
```

### Integration into Alert Delivery

**File: `apps/web/lib/alert-email.ts`**

Extend `deliverAlert` to also send to Slack:

```typescript
import { sendSlack } from './slack.ts'
import { getAlertChannels } from '@scanlyfix/db'

export async function deliverAlert(alertId: string): Promise<SendResult> {
  const alert = await alertForDelivery(alertId)
  if (!alert) return { sent: false, reason: 'alert no longer exists' }
  if (alert.sentAt) return { sent: false, reason: 'already delivered' }

  const { subject, text } = render(alert)

  // Send email
  const emailResult = await sendEmail({
    to: alert.recipientEmail,
    subject,
    text,
    html: asHtml(text),
  })

  // Send to Slack if configured
  const channels = await getAlertChannels(alert.projectId)
  const slackChannel = channels.find((c) => c.channel === 'slack' && c.enabled)
  if (slackChannel?.config.webhookUrl) {
    await sendSlack(slackChannel.config.webhookUrl, {
      text: `*${subject}*\n${text}`,
    })
  }

  if (emailResult.sent) await markAlertSent(alert.id)
  return emailResult
}
```

### Alert Message for Slack

**File: `apps/web/lib/alert-message.ts`**

Add Slack-specific formatter:

```typescript
export function renderSlack(alert: AlertSubject): SlackMessage {
  const host = hostOf(alert.projectUrl)
  const { subject, text } = render(alert)

  return {
    text: `*${subject}*`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${subject}*\n${text}` },
      },
    ],
  }
}
```

### API for Configuration

**File: `apps/web/app/api/projects/[id]/alert-channels/route.ts` (NEW)**

```typescript
// POST /api/projects/:id/alert-channels
// Body: { channel: 'slack', config: { webhookUrl: 'https://hooks.slack.com/...' } }

// GET /api/projects/:id/alert-channels
// Returns list of configured channels
```

---

## Feature 5: On-Deploy Trigger

### What
Trigger a monitoring check immediately when a deployment is detected (via webhook from Vercel, Netlify, GitHub Actions, etc.).

### Why
The worst time to discover a broken deploy is when a cron fires 5 minutes later. An on-deploy trigger catches deploy-time failures in seconds.

### Implementation

**File: `apps/web/app/api/monitors/deploy-hook/route.ts` (NEW)**

```typescript
/**
 * POST /api/monitors/deploy-hook?token=<secret>
 *
 * External CI/CD systems call this after a successful deploy.
 * Triggers an immediate uptime check for all monitors on the project.
 *
 * Auth: Bearer token in query string (not header) for easy webhook config.
 */

import { NextResponse } from 'next/server'
import { db, monitors, projects } from '@scanlyfix/db'
import { eq } from 'drizzle-orm'
import { inngest, EVENTS } from '@/lib/inngest.ts'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const url = new URL(request.url)
  const token = url.searchParams.get('token')

  // Validate token
  if (!token || token !== process.env.DEPLOY_HOOK_SECRET) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const projectUrl: string | undefined = body.url ?? body.project_url

  if (!projectUrl) {
    return NextResponse.json({ error: 'Missing url in body' }, { status: 400 })
  }

  // Find project by URL
  const project = await db.query.projects.findFirst({
    where: eq(projects.url, projectUrl),
    columns: { id: true },
  })
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  // Find all enabled monitors for this project
  const projectMonitors = await db.query.monitors.findMany({
    where: eq(monitors.projectId, project.id),
  })

  // Emit events for each monitor
  const events = projectMonitors
    .filter((m) => m.enabled)
    .map((m) =>
      inngest.send(EVENTS.monitorDue, {
        data: {
          monitorId: m.id,
          type: m.type,
          projectId: project.id,
          url: projectUrl,
          triggeredBy: 'deploy-hook',
        },
      }),
    )

  await Promise.all(events)

  return NextResponse.json({
    triggered: events.length,
    monitors: projectMonitors.map((m) => ({ id: m.id, type: m.type })),
  })
}
```

**File: `apps/web/inngest/functions/types.ts`**

Update `MonitorDueEvent`:

```typescript
export interface MonitorDueEvent {
  data: {
    monitorId: string
    type: MonitorType
    projectId: string
    url: string
    triggeredBy?: 'cron' | 'deploy-hook' | 'manual'
  }
}
```

### Vercel Integration

Add to Vercel project settings → Deploy Hooks:
- URL: `https://yourapp.com/api/monitors/deploy-hook?token=<secret>`
- Triggers on: `Deployment Created`

### GitHub Actions Integration

```yaml
# .github/workflows/deploy.yml
- name: Trigger monitoring
  run: |
    curl -X POST "https://yourapp.com/api/monitors/deploy-hook?token=${{ secrets.DEPLOY_HOOK_TOKEN }}" \
      -H "Content-Type: application/json" \
      -d '{"url": "${{ secrets.PROJECT_URL }}"}'
```

---

## Feature 6: Severity Threshold

### What
Allow users to configure what counts as "down" — e.g., only alert on 5xx, or alert on any non-200.

### Why
Different sites have different tolerances. An API returning 400 on bad input is normal. A marketing site returning 404 is a problem. One-size-fits-all thresholds create noise.

### Database Changes

**File: `packages/db/src/schema.ts`**

Add column to `monitors` table:

```typescript
/** JSON config for alert thresholds. */
alertConfig: jsonb('alert_config').$type<{
  /** HTTP status codes that count as DOWN. Default: [5xx]. */
  failStatusCodes?: number[]
  /** Maximum acceptable latency in ms. null = no latency alerting. */
  maxLatencyMs?: number
  /** Percentage of checks that must fail before alerting. Default: 100 (all). */
  failThresholdPercent?: number
}>(),
```

### Query Changes

**File: `packages/db/src/queries/monitors.ts`**

Update `recordMonitorRun` to check thresholds:

```typescript
export async function recordMonitorRun(
  monitorId: string,
  outcome: MonitorOutcome,
  alertConfig?: { failStatusCodes?: number[]; maxLatencyMs?: number },
): Promise<void> {
  // Determine if this counts as a failure based on thresholds
  let isDown = !outcome.ok

  if (alertConfig?.failStatusCodes && outcome.statusCode) {
    // Only count specific status codes as failures
    isDown = alertConfig.failStatusCodes.includes(outcome.statusCode)
  }

  if (alertConfig?.maxLatencyMs && outcome.latencyMs) {
    // Also flag slow responses
    isDown = isDown || outcome.latencyMs > alertConfig.maxLatencyMs
  }

  await db.transaction(async (tx) => {
    await tx.insert(monitorEvents).values({
      monitorId,
      ok: !isDown,
      statusCode: outcome.statusCode ?? null,
      latencyMs: outcome.latencyMs ?? null,
      detail: outcome.detail ?? null,
    })
    await tx
      .update(monitors)
      .set({ lastRunAt: new Date(), lastStatus: isDown ? 'down' : 'up' })
      .where(eq(monitors.id, monitorId))
  })
}
```

### UI for Configuration

**File: `apps/web/components/monitors/monitor-settings.tsx` (NEW)**

```tsx
// Add to monitor detail page:
// - Dropdown: "Alert on" → 5xx only / 4xx and 5xx / Any non-200
// - Input: "Max latency (ms)" → optional, shows warning when exceeded
// - Save button
```

### API Update

**File: `apps/web/app/api/monitors/[id]/config/route.ts` (NEW)**

```typescript
// PATCH /api/monitors/:id/config
// Body: { failStatusCodes: [500, 502, 503], maxLatencyMs: 5000 }
```

---

## Feature 7: Snooze Rules

### What
Temporarily silence alerts for a monitor. Useful during planned maintenance windows.

### Why
During a deploy or migration, the site WILL go down. The user knows about it. Getting alerted for something you intentionally caused is noise, not signal.

### Database Changes

**File: `packages/db/src/schema.ts`**

Add new table:

```typescript
export const snoozedMonitors = pgTable(
  'snoozed_monitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    /** When the snooze expires. null = snoozed indefinitely until manually unsnoozed. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Why it's snoozed — shows in the UI. */
    reason: text('reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('snoozed_monitors_monitor_idx').on(t.monitorId)],
)
```

### Query Functions

**File: `packages/db/src/queries/monitors.ts`**

```typescript
export async function isMonitorSnoozed(monitorId: string): Promise<boolean> {
  const snooze = await db.query.snoozedMonitors.findFirst({
    where: and(
      eq(snoozedMonitors.monitorId, monitorId),
      or(
        isNull(snoozedMonitors.expiresAt),
        gte(snoozedMonitors.expiresAt, new Date()),
      ),
    ),
    columns: { id: true },
  })
  return snooze !== undefined
}

export async function snoozeMonitor(
  monitorId: string,
  userId: string,
  options: { expiresAt?: Date; reason?: string },
): Promise<void> {
  await db.insert(snoozedMonitors).values({
    monitorId,
    createdBy: userId,
    expiresAt: options.expiresAt ?? null,
    reason: options.reason ?? null,
  })
}

export async function unsnoozeMonitor(monitorId: string): Promise<void> {
  await db
    .delete(snoozedMonitors)
    .where(eq(snoozedMonitors.monitorId, monitorId))
}
```

### Guard in Probe

**File: `apps/web/inngest/functions/uptime-probe.ts`**

Add snooze check at the start:

```typescript
import { isMonitorSnoozed } from '@scanlyfix/db'

async ({ event, step }) => {
  const { monitorId, projectId, url } = event.data as MonitorDueEvent['data']

  // Skip if snoozed
  if (await isMonitorSnoozed(monitorId)) {
    return { ok: true, alerted: false, streak: 0, alertId: null, snoozed: true }
  }

  // ... rest of the function
}
```

### API Routes

**File: `apps/web/app/api/monitors/[id]/snooze/route.ts` (NEW)**

```typescript
// POST /api/monitors/:id/snooze
// Body: { expiresAt: '2024-01-01T12:00:00Z', reason: 'Deploying v2.0' }

// DELETE /api/monitors/:id/snooze
// Unsnooze immediately
```

### UI

**File: `apps/web/components/monitors/monitor-detail.tsx`**

Add snooze button to monitor detail:

```tsx
{isSnoozed ? (
  <button onClick={unsnooze} className="... bg-amber-100 text-amber-700">
    🔕 Snoozed — Resume Alerts
  </button>
) : (
  <button onClick={() => setShowSnoozeModal(true)} className="...">
    Snooze Alerts
  </button>
)}
```

Snooze modal options:
- 1 hour
- 4 hours
- 24 hours
- Until specific date/time
- Indefinite (until manually resumed)

---

## Implementation Order

### Phase 1: Quick Wins (Low complexity, high value)
1. **Snooze rules** — Simple table + guard check. Ship in 1-2 hours.
2. **Slack webhook** — HTTP POST to webhook URL. Ship in 2-3 hours.
3. **On-deploy trigger** — New API route + event emit. Ship in 2-3 hours.

### Phase 2: Medium Complexity
4. **Severity threshold** — Config column + evaluation logic. Ship in 3-4 hours.
5. **What-changed diff view** — Store diff in event + render. Ship in 4-5 hours.

### Phase 3: High Complexity
6. **DNS drift detection** — New checker + diff logic. Ship in 5-6 hours.
7. **Core Web Vitals alerts** — PSI integration + thresholds. Ship in 6-8 hours.

---

## Commands to Run After Implementation

```bash
# After schema changes
cd packages/db
pnpm db:generate    # Generate migration file
pnpm db:migrate     # Apply to database

# From root
pnpm typecheck      # Verify all types compile
pnpm test           # Run all tests

# Start dev server
pnpm dev            # Next.js dev server (includes Inngest)
```

---

## Environment Variables Needed

```bash
# Slack (Feature 4)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx

# Deploy Hook (Feature 5)
DEPLOY_HOOK_SECRET=your-random-secret-here

# Core Web Vitals (Feature 7)
PSI_API_KEY=your-google-api-key  # Optional, rate-limited without it
```

---

## Testing Checklist

- [ ] DNS drift: Change A record → verify alert fires
- [ ] Diff view: Trigger fail → verify diff shows in UI
- [ ] Web Vitals: Slow page → verify threshold alert
- [ ] Slack: Configure webhook → verify message arrives
- [ ] Deploy hook: POST to endpoint → verify check runs
- [ ] Severity: Set 5xx only → verify 4xx doesn't alert
- [ ] Snooze: Snooze monitor → verify no alerts during window

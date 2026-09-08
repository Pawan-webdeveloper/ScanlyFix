# Monitor Feature — Implementation Plan

## Mapping: Your Requirements → Existing Project

Your Steps 1-8 mapped to this codebase. The project already has significant monitor infrastructure. This plan shows exactly what exists, what to add, and which file to touch.

### What Already Exists

| Your Requirement | Status | Existing Implementation |
|---|---|---|
| `monitors` table | EXISTS | `packages/db/src/schema.ts:366` — has `id`, `projectId`, `type`, `intervalS`, `enabled`, `lastRunAt`, `lastStatus` |
| `monitor_logs` table | EXISTS as `monitor_events` | `packages/db/src/schema.ts:394` — has `monitorId`, `ok`, `statusCode`, `latencyMs`, `ts`, `detail` |
| `incidents` table | DOES NOT EXIST | New table to create |
| URL checker worker | EXISTS as Inngest function | `apps/web/inngest/functions/uptime-probe.ts` — uses `safeFetch()` |
| Retry/false positive logic | EXISTS | `packages/db/src/queries/monitors.ts:150` — `consecutiveFailures()` checks 2-in-a-row |
| Cron scheduler | EXISTS | Inngest cron triggers + `sweep.ts` fetches due monitors |
| State-change alerts | EXISTS | `uptime-probe.ts` compares `last_status`, only alerts on DOWN |
| Resend email | EXISTS | `apps/web/lib/email.ts` — Resend API via fetch |
| Alert dedup | EXISTS | `packages/db/src/queries/alerts.ts:32` — `recordAlertOnce()` per project/kind/day |

### What Needs to Be Built

| Phase | What | Files to Create/Modify |
|---|---|---|
| Step 1 | `incidents` table | `packages/db/src/schema.ts`, generate migration |
| Step 2 | No BullMQ needed — Inngest is the worker | Nothing (already works) |
| Step 3 | `checkUrl()` exists as `uptime-probe.ts` | Already implemented |
| Step 4 | Retry logic exists | Already implemented |
| Step 5 | Cron exists via Inngest | Already implemented |
| Step 6 | State-change alerts exist | Already implemented |
| Step 7 | API routes for dashboard | `apps/web/app/api/monitors/route.ts` (new), `apps/web/app/api/monitors/[id]/...` (new) |
| Step 8 | Frontend dashboard | `apps/web/app/(app)/dashboard/` or new `(app)/monitors/` page |

---

## Phase 1 — Database (Step 1)

### What Already Exists

The `monitors` and `monitor_events` tables are already in `packages/db/src/schema.ts`. Your column names map to:

| Your Name | Existing Column | Table |
|---|---|---|
| URL | `projects.url` (joined via `projectId`) | `projects` |
| user_id | `projects.ownerId` (joined via `projectId`) | `projects` |
| check_interval | `intervalS` (in seconds) | `monitors` |
| is_active | `enabled` | `monitors` |
| last_status | `lastStatus` | `monitors` |
| status_code | `statusCode` | `monitor_events` |
| response_time | `latencyMs` | `monitor_events` |
| is_up | `ok` | `monitor_events` |
| checked_at | `ts` | `monitor_events` |

### What to Create: `incidents` Table

**File:** `packages/db/src/schema.ts`

Add after the `alerts` table (around line 430):

```typescript
/* -------------------------------------------------------------------------- */
/* Incidents                                                                  */
/* -------------------------------------------------------------------------- */

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    monitorId: uuid('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Duration in milliseconds. NULL while incident is ongoing. */
    durationMs: integer('duration_ms'),
    /** The status code that triggered the incident, if available. */
    statusCode: integer('status_code'),
    detail: text('detail'),
  },
  (t) => [
    index('incidents_monitor_started_idx').on(t.monitorId, desc(t.startedAt)),
    // Find unresolved incidents efficiently (active incidents query).
    index('incidents_unresolved_idx').on(t.monitorId, t.resolvedAt),
  ],
)
```

Add relations after `monitorEventsRelations` (around line 694):

```typescript
export const incidentsRelations = relations(incidents, ({ one }) => ({
  monitor: one(monitors, { fields: [incidents.monitorId], references: [monitors.id] }),
}))
```

Add inferred types at the bottom:

```typescript
export type Incident = typeof incidents.$inferSelect
export type NewIncident = typeof incidents.$inferInsert
```

**Then generate migration:**

```bash
cd packages/db
pnpm db:generate
pnpm db:migrate
```

**Export from index:** Add to `packages/db/src/index.ts`:

```typescript
// (already exports * from schema.ts, so Incident types come through automatically)
```

---

## Phase 2 — Checker Worker (Steps 2-4)

### Why No BullMQ

The project already uses **Inngest** as its background job system. Inngest provides:
- Queue management (jobs are events, not manual queue inserts)
- Automatic retries with configurable backoff
- Concurrency limits
- Step-based execution with memoization
- Cron triggers built-in

Adding BullMQ would create a second job system with its own Redis connection, its own monitoring, and its own failure modes. Inngest already handles everything BullMQ would do.

### Existing `checkUrl()` — `uptime-probe.ts`

**File:** `apps/web/inngest/functions/uptime-probe.ts`

This already does exactly what your `checkUrl()` needs:

```
1. safeFetch(url, { timeoutMs: 15_000 })     ← your axios GET with 10s timeout
2. Measures latency: Date.now() - startedAt   ← your response time calculation
3. status < 400 = UP, else DOWN               ← your 200-399 = UP logic
4. try-catch wraps everything                 ← your try-catch requirement
5. recordMonitorRun() saves to DB             ← your monitor_logs save
```

### Existing Retry Logic — False Positive Prevention

**File:** `packages/db/src/queries/monitors.ts:150`

```typescript
export async function consecutiveFailures(monitorId: string, look = 5): Promise<number>
```

This checks the last 5 events. If 2+ consecutive failures → alert fires. This IS your retry system:

```
Check 1 fails → recorded, streak = 1, NO alert
Check 2 fails → recorded, streak = 2, ALERT FIRES
Check 3 succeeds → streak resets to 0
```

**File:** `apps/web/inngest/functions/uptime-probe.ts:64`

```typescript
const streak = await consecutiveFailures(monitorId)
if (streak < FAILURES_BEFORE_ALERT) {
  return { ok: false, alerted: false, streak, alertId: null }
}
```

`FAILURES_BEFORE_ALERT = 2` — exactly your "2 baar fail hone ke baad hi down maano" rule.

### If You Want to Change Retry Count

Edit `apps/web/inngest/functions/uptime-probe.ts:26`:

```typescript
const FAILURES_BEFORE_ALERT = 2  // change to 3 for more conservative alerting
```

---

## Phase 3 — Scheduler (Step 5)

### Existing Cron System

Inngest handles scheduling via cron triggers. The flow:

```
Inngest cron trigger (every N minutes)
  → apps/web/inngest/functions/scheduled-rescan.ts
    → emits "scanlyfix/monitor.due" events for due monitors
  → apps/web/inngest/functions/sweep.ts
    → queries dueMonitorsForScheduler() from DB
    → emits events for each due monitor
  → uptime-probe.ts picks up "monitor.due" events
    → runs the check
```

**Key file:** `apps/web/inngest/functions/sweep.ts` — the scheduler that finds due monitors and dispatches jobs.

**Key query:** `packages/db/src/queries/monitors.ts:74` — `dueMonitorsForScheduler()`:

```sql
-- Finds monitors where:
-- enabled = true AND
-- (never run OR last run > intervalS seconds ago)
SELECT ... FROM monitors
WHERE enabled = true
  AND (last_run_at IS NULL OR last_run_at <= now() - make_interval(secs => interval_s))
ORDER BY coalesce(last_run_at, 'epoch'::timestamptz)
LIMIT 500
```

### To Change Check Interval

The interval is per-monitor, stored in `monitors.intervalS` (seconds). Default is 3600 (1 hour).

For free plan (every 5 minutes = 300 seconds), set when creating/updating a monitor:

```typescript
// In the setMonitor() call:
{ type: 'uptime', enabled: true, intervalS: 300 }
```

---

## Phase 4 — Alerts (Step 6)

### Existing State-Change Alert System

**File:** `apps/web/inngest/functions/uptime-probe.ts`

The complete flow:

```
1. Probe runs → gets outcome (ok, statusCode, latencyMs)
2. recordMonitorRun() → saves to monitor_events + updates monitors.lastStatus
3. Compare with previous state:
   - UP → UP:   no alert
   - UP → DOWN: recordAlertOnce() + deliverAlert() + create incident
   - DOWN → UP: mark incident resolved
   - DOWN → DOWN: no alert (already alerted)
4. deliverAlert() → Resend email
```

### Existing Resend Integration

**File:** `apps/web/lib/email.ts`

Already configured:
- Uses Resend API via `fetch()` (no SDK dependency)
- From: `ScanlyFix <onboarding@resend.dev>` (sandbox) or `ALERT_FROM_EMAIL` env
- Handles network errors (thrown for retry) vs config errors (returned as failure)
- Timeout: 10s

### What to Add: Incident Creation on DOWN

Currently, when DOWN is detected, an alert is created but no incident row. Add incident creation.

**File:** `apps/web/inngest/functions/uptime-probe.ts`

Modify the `record-and-alert` step to also create an incident:

```typescript
// After recordAlertOnce succeeds:
if (alert) {
  await step.run('create-incident', () =>
    createIncident(monitorId, { statusCode: outcome.statusCode, detail: outcome.detail })
  )
}
```

**File:** `packages/db/src/queries/monitors.ts`

Add new function:

```typescript
export async function createIncident(
  monitorId: string,
  meta: { statusCode?: number | null; detail?: string | null },
): Promise<void> {
  await db.insert(incidents).values({
    monitorId,
    startedAt: new Date(),
    statusCode: meta.statusCode ?? null,
    detail: meta.detail ?? null,
  })
}

export async function resolveIncident(monitorId: string): Promise<void> {
  // Find the most recent unresolved incident for this monitor
  const open = await db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      isNull(incidents.resolvedAt),
    ),
    orderBy: desc(incidents.startedAt),
  })
  if (!open) return

  const durationMs = Date.now() - open.startedAt.getTime()
  await db
    .update(incidents)
    .set({ resolvedAt: new Date(), durationMs })
    .where(eq(incidents.id, open.id))
}
```

**File:** `apps/web/inngest/functions/uptime-probe.ts`

Add recovery handling (DOWN → UP):

```typescript
// In the record-and-alert step, after checking streak:
if (outcome.ok) {
  // Site is back up — resolve any open incident
  await step.run('resolve-incident', () => resolveIncident(monitorId))
  return { ok: true, alerted: false, streak: 0, alertId: null }
}
```

---

## Phase 5 — Dashboard APIs (Step 7)

### File Structure to Create

```
apps/web/app/api/monitors/
├── route.ts                    # GET /monitors — list user's monitors
└── [id]/
    ├── logs/route.ts           # GET /monitors/:id/logs — last 100 checks
    ├── uptime/route.ts         # GET /monitors/:id/uptime — 24h/7d/30d uptime %
    └── incidents/route.ts      # GET /monitors/:id/incidents — all downtime incidents
```

### API 1: GET /monitors

**File:** `apps/web/app/api/monitors/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { listMonitors } from '@scanlyfix/db'
import { getViewer } from '@/lib/auth/supabase'

export async function GET() {
  const viewer = await getViewer()
  if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // List all monitors for all user's projects
  // Need a new query: listMonitorsForUser(viewer)
  const monitors = await listMonitorsForUser(viewer)
  return NextResponse.json({ monitors })
}
```

**New query needed in** `packages/db/src/queries/monitors.ts`:

```typescript
export async function listMonitorsForUser(viewer: Viewer): Promise<Array<Monitor & { projectUrl: string; projectName: string }>> {
  if (!viewer.userId) return []
  return db
    .select({
      id: monitors.id,
      type: monitors.type,
      projectId: monitors.projectId,
      enabled: monitors.enabled,
      intervalS: monitors.intervalS,
      lastRunAt: monitors.lastRunAt,
      lastStatus: monitors.lastStatus,
      createdAt: monitors.createdAt,
      projectUrl: projects.url,
      projectName: projects.name,
    })
    .from(monitors)
    .innerJoin(projects, eq(projects.id, monitors.projectId))
    .where(eq(projects.ownerId, viewer.userId))
    .orderBy(desc(monitors.createdAt))
}
```

### API 2: GET /monitors/:id/logs

**File:** `apps/web/app/api/monitors/[id]/logs/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { recentEvents } from '@scanlyfix/db'
import { getViewer } from '@/lib/auth/supabase'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const viewer = await getViewer()
  if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const events = await recentEvents(id, viewer, 100)
  return NextResponse.json({ logs: events })
}
```

This query already exists: `packages/db/src/queries/monitors.ts:129`

### API 3: GET /monitors/:id/uptime

**File:** `apps/web/app/api/monitors/[id]/uptime/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { getViewer } from '@/lib/auth/supabase'
import { getUptime } from '@scanlyfix/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const viewer = await getViewer()
  if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const url = new URL(request.url)
  const period = url.searchParams.get('period') ?? '24h' // 24h | 7d | 30d

  const uptime = await getUptime(id, viewer, period)
  return NextResponse.json(uptime)
}
```

**New query needed in** `packages/db/src/queries/monitors.ts`:

```typescript
export async function getUptime(
  monitorId: string,
  viewer: Viewer,
  period: '24h' | '7d' | '30d',
): Promise<{ total: number; up: number; down: number; uptimePercent: number }> {
  // Verify viewer has access
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { projectId: true },
  })
  if (!monitor || !(await getProject(monitor.projectId, viewer))) {
    return { total: 0, up: 0, down: 0, uptimePercent: 100 }
  }

  const intervalMap = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }
  const interval = intervalMap[period]

  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
      up: sql<number>`count(*) filter (where ${monitorEvents.ok})::int`,
    })
    .from(monitorEvents)
    .where(
      and(
        eq(monitorEvents.monitorId, monitorId),
        gte(monitorEvents.ts, sql`now() - interval '${sql.raw(interval)}'`),
      ),
    )

  const { total, up } = result[0]!
  const down = total - up
  const uptimePercent = total === 0 ? 100 : (up / total) * 100

  return { total, up, down, uptimePercent }
}
```

### API 4: GET /monitors/:id/incidents

**File:** `apps/web/app/api/monitors/[id]/incidents/route.ts`

```typescript
import { NextResponse } from 'next/server'
import { getViewer } from '@/lib/auth/supabase'
import { listIncidents } from '@scanlyfix/db'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const viewer = await getViewer()
  if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const incidents = await listIncidents(id, viewer, 50)
  return NextResponse.json({ incidents })
}
```

**New query needed in** `packages/db/src/queries/monitors.ts`:

```typescript
export async function listIncidents(
  monitorId: string,
  viewer: Viewer,
  limit = 50,
): Promise<Incident[]> {
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { projectId: true },
  })
  if (!monitor || !(await getProject(monitor.projectId, viewer))) return []

  return db.query.incidents.findMany({
    where: eq(incidents.monitorId, monitorId),
    orderBy: desc(incidents.startedAt),
    limit,
  })
}
```

---

## Phase 6 — Frontend Dashboard (Step 8)

### Option A: New Page Under (app)

**Create:** `apps/web/app/(app)/monitors/page.tsx`

This gives you a dedicated `/monitors` route in the authenticated area.

**File structure to create:**

```
apps/web/app/(app)/monitors/
├── page.tsx                    # Main monitors list page
└── [id]/
    └── page.tsx                # Single monitor detail page

apps/web/components/monitors/
├── monitor-row.tsx             # EXISTS — single monitor row with toggle
├── uptime-chart.tsx            # EXISTS — 90-day uptime strip
├── uptime-days.ts              # EXISTS — day grouping logic
├── monitor-list.tsx            # NEW — list of all monitors
├── monitor-detail.tsx          # NEW — single monitor detail view
├── response-time-chart.tsx     # NEW — response time graph (24h)
├── uptime-badge.tsx            # NEW — "99.9%" uptime display
├── incidents-list.tsx          # NEW — incidents table
└── status-dot.tsx              # NEW — green/red UP/DOWN indicator
```

### Component: `monitor-list.tsx`

```typescript
// Fetches GET /monitors, renders a list of MonitorRow components
// Each row shows: status dot, project name, URL, uptime %, last check time
// Click navigates to /monitors/[id]
```

### Component: `monitor-detail.tsx`

```
┌─────────────────────────────────────────────────┐
│ ● example.com                           UP      │
│ https://example.com                             │
│                                                 │
│ Uptime: 99.97%     Last check: 2 min ago        │
│ Response: 234ms     Interval: every 5 min        │
│                                                 │
│ ┌─ Response Time (24h) ──────────────────────┐  │
│ │ ▁▁▂▁▁▃▁▁▁▂▁▁▁▁▃▁▁▁▂▁▁▁▁▃▁▁▁▂▁▁▁▁       │  │
│ │ 150ms ──────────────────── 350ms           │  │
│ └────────────────────────────────────────────┘  │
│                                                 │
│ ┌─ Uptime (90 days) ─────────────────────────┐  │
│ │ ████████████████████████████░░█████████████ │  │
│ │ 99.97% uptime · 2 failed checks            │  │
│ └────────────────────────────────────────────┘  │
│                                                 │
│ ┌─ Recent Incidents ─────────────────────────┐  │
│ │ Oct 15, 14:32 — 14:47 (15 min)            │  │
│ │ Oct 03, 09:12 — 09:34 (22 min)            │  │
│ └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Polling for Live Updates

Use `setInterval` in a client component:

```typescript
'use client'
import { useState, useEffect } from 'react'

export function useMonitorPolling(monitorId: string, intervalMs = 30_000) {
  const [data, setData] = useState(null)

  useEffect(() => {
    const fetch_ = async () => {
      const res = await fetch(`/api/monitors/${monitorId}/logs?limit=1`)
      const json = await res.json()
      setData(json.logs[0])
    }
    fetch_()
    const id = setInterval(fetch_, intervalMs)
    return () => clearInterval(id)
  }, [monitorId, intervalMs])

  return data
}
```

### Response Time Chart

For the response time graph (last 24h), you have two options:

1. **Simple (no dependency):** Bar chart like `uptime-chart.tsx` — bars colored by response time thresholds
2. **With library:** Install `recharts` — `pnpm add recharts` in `apps/web`

Recommendation: Start with option 1 (no new dependency), upgrade later if needed.

---

## Complete File Change List

### New Files to Create

| File | Purpose |
|---|---|
| `apps/web/app/api/monitors/route.ts` | GET /monitors API |
| `apps/web/app/api/monitors/[id]/logs/route.ts` | GET /monitors/:id/logs API |
| `apps/web/app/api/monitors/[id]/uptime/route.ts` | GET /monitors/:id/uptime API |
| `apps/web/app/api/monitors/[id]/incidents/route.ts` | GET /monitors/:id/incidents API |
| `apps/web/app/(app)/monitors/page.tsx` | Monitors list page |
| `apps/web/app/(app)/monitors/[id]/page.tsx` | Single monitor detail page |
| `apps/web/components/monitors/monitor-list.tsx` | Monitor list component |
| `apps/web/components/monitors/monitor-detail.tsx` | Monitor detail component |
| `apps/web/components/monidents/response-time-chart.tsx` | Response time chart |
| `apps/web/components/monitors/uptime-badge.tsx` | Uptime percentage badge |
| `apps/web/components/monitors/incidents-list.tsx` | Incidents list component |
| `apps/web/components/monitors/status-dot.tsx` | UP/DOWN status indicator |

### Files to Modify

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | Add `incidents` table + relations + types |
| `packages/db/src/queries/monitors.ts` | Add `listMonitorsForUser()`, `getUptime()`, `listIncidents()`, `createIncident()`, `resolveIncident()` |
| `apps/web/inngest/functions/uptime-probe.ts` | Add incident creation on DOWN, resolve on UP |
| `apps/web/lib/alert-message.ts` | Add incident-related alert message templates |
| `apps/web/components/console/nav.ts` | Add "Monitors" nav link |

---

## Implementation Order

```
1. packages/db/src/schema.ts          — Add incidents table
2. packages/db drizzle generate       — Generate migration SQL
3. packages/db drizzle migrate        — Apply migration to DB
4. packages/db/src/queries/monitors.ts — Add new query functions
5. apps/web/inngest/functions/uptime-probe.ts — Add incident create/resolve
6. apps/web/app/api/monitors/route.ts        — List monitors API
7. apps/web/app/api/monitors/[id]/logs/route.ts      — Logs API
8. apps/web/app/api/monitors/[id]/uptime/route.ts    — Uptime API
9. apps/web/app/api/monitors/[id]/incidents/route.ts — Incidents API
10. apps/web/components/monitors/status-dot.tsx       — Status indicator
11. apps/web/components/monitors/uptime-badge.tsx     — Uptime badge
12. apps/web/components/monitors/response-time-chart.tsx — Response chart
13. apps/web/components/monitors/incidents-list.tsx    — Incidents list
14. apps/web/components/monitors/monitor-list.tsx      — Monitor list
15. apps/web/components/monitors/monitor-detail.tsx    — Monitor detail
16. apps/web/app/(app)/monitors/page.tsx              — List page
17. apps/web/app/(app)/monitors/[id]/page.tsx         — Detail page
18. apps/web/components/console/nav.ts                — Add nav link
19. pnpm typecheck                                   — Verify types
20. pnpm test                                        — Run tests
```

---

## Commands to Run

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

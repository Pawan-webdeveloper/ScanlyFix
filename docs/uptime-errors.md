# Uptime Feature — Error Report

## 1. `packages/db/src/queries/monitors.ts` — Missing `gte` import (breaks uptime query)

**Lines 12, 293:** The `getUptime()` function (lines 269-303) is the core uptime percentage calculator. It uses `gte` on line 293 but `gte` is not imported.

```ts
// Line 12 — gte is missing from import
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'

// Line 293 — getUptime() uses gte, will crash at runtime
gte(monitorEvents.ts, sql`now() - interval '${sql.raw(intervalMap[period])}'`),
```

**Impact:** Every call to `GET /api/monitors/[id]/uptime` will throw `ReferenceError: gte is not defined`.

**Fix:** Add `gte` to the import on line 12.

---

## 2. `apps/web/inngest/functions/monitoring-probe.ts` — Hardcoded absolute paths (SECURITY)

**Lines 22-23:** The monitoring probe (which handles SSL/domain monitoring — part of the uptime system) uses hardcoded developer-machine paths.

```ts
import { checkSsl } from '/Users/sahilpanwar/Ghost/PROJECTS/darvin/packages/checks/src/ssl-checker.ts'
import { checkDomain } from '/Users/sahilpanwar/Ghost/PROJECTS/darvin/packages/checks/src/domain-checker.ts'
```

**Security issues:**
- **Information disclosure:** Exposes internal directory structure and developer username.
- **Non-portable:** Will fail on CI, production, and any other machine.
- **Supply chain risk:** If someone gains write access to that path on the machine, they can inject code that runs in the monitoring probe.

**Fix:** Use package alias:
```ts
import { checkSsl } from '@scanlyfix/checks'
import { checkDomain } from '@scanlyfix/checks'
```

---

## 3. `apps/web/app/api/monitors/[id]/monitoring/route.ts` — Deep relative paths crossing packages (SECURITY)

**Lines 15-16, 19:** The monitoring API route (serves live SSL/domain data for the uptime dashboard) uses 7-level-deep relative imports.

```ts
import { checkSsl } from '../../../../../../../packages/checks/src/ssl-checker.ts'
import { checkDomain } from '../../../../../../../packages/checks/src/domain-checker.ts'
import { monitors, projects } from '../../../../../../../packages/db/src/schema.ts'
```

**Security issues:**
- Exposes internal package structure to anyone reading the source.
- Fragile — any directory restructuring breaks the build silently or with confusing errors.

**Fix:** Use package aliases (`@scanlyfix/checks`, `@scanlyfix/db`).

---

## 4. `apps/web/app/api/monitors/[id]/monitoring/route.ts` — Missing authorization check

**Lines 36-42:** The route fetches monitor data by ID but only checks that the viewer is a logged-in user — it does **not** verify that the monitor belongs to the viewer's project.

```ts
const row = await db
  .select({ url: projects.url, projectId: monitors.projectId, type: monitors.type })
  .from(monitors)
  .innerJoin(projects, eq(projects.id, monitors.projectId))
  .where(eq(monitors.id, id))
  .limit(1)
  .then((r) => r[0] ?? null)

// Only checks type, NOT ownership
if (!row || row.type !== 'domain') {
  return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
}
```

**Security issue:** Any authenticated user can probe SSL/domain expiry for any monitor ID, including monitors belonging to other users' projects. This is an **IDOR (Insecure Direct Object Reference)** vulnerability.

**Fix:** Add ownership check:
```ts
if (!row || row.type !== 'domain') { ... }
// Add: verify viewer owns the project
if (!(await getProject(row.projectId, viewer))) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
}
```

---

## 5. `apps/web/components/monitors/uptime-badge.tsx` — Missing `use client` directive consistency

**Line 1:** Has `'use client'` — correct. But `uptime-chart.tsx` (line 10) is a client component that does NOT have `'use client'` at the top.

```tsx
// uptime-chart.tsx — missing 'use client' but uses client-side rendering
export function UptimeChart({ events }: { ... }) {
```

This may work because it's imported from a client component (`monitor-detail.tsx`), but if it's ever imported from a server component, it will fail.

---

## 6. `apps/web/inngest/functions/types.ts` — Type mismatch between `MonitorDueEvent` and sweep payload

**Line 29:** `MonitorDueEvent` declares `ownerId: string` in its data shape.

```ts
export interface MonitorDueEvent {
  data: {
    monitorId: string
    type: MonitorType
    projectId: string
    url: string
    ownerId: string  // <-- declared but never sent
  }
}
```

In `monitor-sweep.ts:39-47`, the event is sent **without** `ownerId`:

```ts
data: {
  monitorId: monitor.id,
  projectId: monitor.projectId,
  url: monitor.projectUrl,
  type: monitor.type,
  // ownerId: monitor.ownerId  <-- NOT sent
},
```

In `uptime-probe.ts:36`, the data is cast without checking:
```ts
const { monitorId, projectId, url } = event.data as MonitorDueEvent['data']
```

**Impact:** If `uptime-probe.ts` ever tries to use `event.data.ownerId`, it will be `undefined`. Currently it doesn't use it, but the type is incorrect and misleading.

---

## 7. `packages/worker/src/monitor.checker.ts` — No SSRF protection on direct `fetch` (SECURITY)

**Lines 55-59:** The worker's monitor checker uses raw `fetch()` directly.

```ts
const res = await fetch(monitor.url, {
  method: 'HEAD',
  signal: AbortSignal.timeout(10_000),
  redirect: 'follow',
})
```

Compare to `uptime-probe.ts:41` which uses `safeFetch` from `@scanlyfix/checks`:
```ts
const response = await safeFetch(url, { timeoutMs: PROBE_TIMEOUT_MS, maxBodyBytes: 4096 })
```

**Security issue:** The worker's checker has **no SSRF protection**. A monitor pointed at `http://169.254.169.254/latest/meta-data/` (cloud metadata) or `http://localhost:xxxx/internal-api` will be fetched by the worker. The `safeFetch` wrapper exists specifically to guard against this.

**Fix:** Replace `fetch` with `safeFetch` from `@scanlyfix/checks`:
```ts
import { safeFetch } from '@scanlyfix/checks'
// ...
const res = await safeFetch(monitor.url, { timeoutMs: 10_000, maxBodyBytes: 4096 })
```

---

## 8. `packages/db/src/queries/monitors.ts:124` — `lastStatus` value inconsistency

**Line 124:** `recordMonitorRun` stores `lastStatus` as `'ok'` or `'failed'`:
```ts
.set({ lastRunAt: new Date(), lastStatus: outcome.ok ? 'ok' : 'failed' })
```

But `monitor-detail.tsx:35` expects the type to be `'ok' | 'failed' | null`:
```ts
lastStatus: 'ok' | 'failed' | null
```

And `monitor-row.tsx:50` checks:
```ts
lastStatus === 'ok' ? 'passing' : 'failing'
```

While `uptime-probe.ts` does not write `lastStatus` at all (it uses `recordMonitorRun` from DB queries which handles it). This is not a bug but an inconsistency — the worker checker and the Inngest probe use different code paths that happen to produce the same values.

---

## 9. `apps/web/components/monitors/monitor-detail.tsx` — No error state for failed fetches

**Lines 59-77:** All three data fetchers (`loadLogs`, `loadUptime`, `loadIncidents`) silently swallow errors with `.catch(() => null)`.

```ts
const loadLogs = useCallback(() => {
  fetch(`/api/monitors/${monitor.id}/logs`)
    .then((r) => r.json())
    .then((d) => setLogs(d.logs ?? []))
    .catch(() => null)  // <-- silently swallowed
}, [monitor.id])
```

**Impact:** If the API is down or returns an error, the user sees an empty state with no indication that data failed to load. They may think "no incidents" when in fact the request failed.

---

## Summary

| # | File | Line(s) | Severity | Issue |
|---|------|---------|----------|-------|
| 1 | `db/src/queries/monitors.ts` | 12, 293 | **High** | Missing `gte` import — uptime query crashes |
| 2 | `inngest/functions/monitoring-probe.ts` | 22-23 | **Security** | Hardcoded absolute paths |
| 3 | `app/api/monitors/[id]/monitoring/route.ts` | 15-16, 19 | **Security** | Deep relative paths expose structure |
| 4 | `app/api/monitors/[id]/monitoring/route.ts` | 36-42 | **Security** | Missing ownership check — IDOR vulnerability |
| 5 | `components/monitors/uptime-chart.tsx` | 1 | **Low** | Missing `'use client'` directive |
| 6 | `inngest/functions/types.ts` | 29 | **Medium** | `ownerId` declared but never sent |
| 7 | `worker/src/monitor.checker.ts` | 55-59 | **Security** | No SSRF protection on direct `fetch` |
| 8 | `db/src/queries/monitors.ts` | 124 | **Low** | `lastStatus` value inconsistency across code paths |
| 9 | `components/monitors/monitor-detail.tsx` | 59-77 | **Medium** | Silent error swallowing — no error UI |

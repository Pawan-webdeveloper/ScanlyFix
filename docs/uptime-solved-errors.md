# Uptime Feature — Solved Errors

## Fix #1: Missing `gte` import (CRITICAL — runtime crash)

**File:** `packages/db/src/queries/monitors.ts`
**Lines:** 12

**Problem:** `gte` was used on line 293 in `getUptime()` but never imported from `drizzle-orm`. Every call to `GET /api/monitors/[id]/uptime` would crash with `ReferenceError: gte is not defined`.

**Fix:** Added `gte` to the drizzle-orm import:
```ts
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
```

---

## Fix #2: Hardcoded absolute paths (SECURITY)

**File:** `apps/web/inngest/functions/monitoring-probe.ts`
**Lines:** 22-23

**Problem:** Used hardcoded developer-machine paths:
```ts
import { checkSsl } from '/Users/sahilpanwar/Ghost/PROJECTS/darvin/packages/checks/src/ssl-checker.ts'
import { checkDomain } from '/Users/sahilpanwar/Ghost/PROJECTS/darvin/packages/checks/src/domain-checker.ts'
```
- Exposed internal filesystem structure (info disclosure)
- Would fail on every other machine (CI, production, other devs)

**Fix:** Replaced with package import:
```ts
import { checkSsl, checkDomain } from '@scanlyfix/checks'
```

---

## Fix #3: Deep relative paths crossing packages

**File:** `apps/web/app/api/monitors/[id]/monitoring/route.ts`
**Lines:** 15-16, 19

**Problem:** Used 7-level-deep relative imports (`../../../../../../../packages/...`) that cross package boundaries. Fragile and exposes internal structure.

**Fix:** Replaced with package aliases and consolidated imports:
```ts
import { checkSsl, checkDomain } from '@scanlyfix/checks'
import { db, getProject, monitors, projects } from '@scanlyfix/db'
```

---

## Fix #4: IDOR vulnerability (SECURITY)

**File:** `apps/web/app/api/monitors/[id]/monitoring/route.ts`
**Lines:** 36-42 (after edit)

**Problem:** The route fetched monitor data by ID but only checked that the viewer was logged in — it did NOT verify that the monitor belonged to the viewer's project. Any authenticated user could probe SSL/domain expiry for any monitor ID.

**Fix:** Added ownership check after fetching the monitor:
```ts
// uptime error — verify the viewer owns this project (IDOR fix)
if (!(await getProject(row.projectId, viewer))) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
}
```

---

## Fix #5: Missing `'use client'` directive

**File:** `apps/web/components/monitors/uptime-chart.tsx`
**Line:** 1

**Problem:** Component uses client-side rendering (flex bars, computed values) but was missing the `'use client'` directive. Would fail if ever imported from a server component.

**Fix:** Added `'use client'` at the top of the file.

---

## Fix #6: `ownerId` type mismatch

**File:** `apps/web/inngest/functions/types.ts`
**Line:** 29

**Problem:** `MonitorDueEvent` declared `ownerId: string` in its data shape, but `monitor-sweep.ts` never sent it in the event payload. The type was a lie — casting `event.data as MonitorDueEvent['data']` masked the mismatch.

**Fix:** Removed `ownerId` from `MonitorDueEvent.data` to match the actual payload:
```ts
export interface MonitorDueEvent {
  name: string
  data: {
    monitorId: string
    type: MonitorType
    projectId: string
    url: string
    // ownerId removed — not sent by monitor-sweep
  }
}
```

---

## Fix #7: No SSRF protection (SECURITY)

**File:** `packages/worker/src/monitor.checker.ts`
**Lines:** 55-59

**Problem:** Used raw `fetch()` for HTTP probes with no SSRF protection. A monitor pointed at `http://169.254.169.254/latest/meta-data/` (cloud metadata) or `http://localhost:xxxx/internal-api` would be fetched by the worker. The `safeFetch` wrapper from `@scanlyfix/checks` exists specifically to prevent this.

**Fix:** Replaced `fetch` with `safeFetch`:
```ts
import { safeFetch } from '@scanlyfix/checks'
// ...
const res = await safeFetch(monitor.url, { timeoutMs: 10_000, maxBodyBytes: 4096 })
```

---

## Fix #8: `lastStatus` value inconsistency

**Files:** `packages/db/src/queries/monitors.ts`, `apps/web/components/monitors/status-dot.tsx`, `apps/web/components/monitors/monitor-detail.tsx`, `apps/web/components/monitors/monitor-list.tsx`, `apps/web/components/monitors/monitor-row.tsx`, `apps/web/app/(app)/monitors/[id]/page.tsx`, `apps/web/app/status/[slug]/page.tsx`

**Problem:** `recordMonitorRun()` stored `'ok'/'failed'` but UI components and type casts were inconsistent across the codebase. Standardized to `'up'/'down'` throughout.

**Fix:** Changed all status values to `'up'/'down'`:
- `monitors.ts`: `lastStatus: outcome.ok ? 'up' : 'down'`
- `status-dot.tsx`: `'up' | 'down' | null`
- `monitor-detail.tsx`: `'up' | 'down' | null`
- `monitor-list.tsx`: `'up' | 'down' | null`
- `monitor-row.tsx`: checks `lastStatus === 'up'`
- `monitors/[id]/page.tsx`: cast `as 'up' | 'down' | null`
- `status/[slug]/page.tsx`: `lastStatus === 'up'`

---

## Fix #9: Silent error swallowing

**File:** `apps/web/components/monitors/monitor-detail.tsx`
**Lines:** 59-77

**Problem:** All three data fetchers (`loadLogs`, `loadUptime`, `loadIncidents`) used `.catch(() => null)` which silently swallowed errors. Users would see empty states with no indication that data failed to load.

**Fix:** Added error states and proper error handling:
- Added `logsError`, `uptimeError`, `incidentsError` state variables
- Fetchers now check `r.ok` and throw on non-2xx responses
- Error states displayed in the UI with red text
- Errors cleared on successful fetch

---

## Files Modified (13 total)

| # | File | Changes |
|---|------|---------|
| 1 | `packages/db/src/queries/monitors.ts` | Added `gte` import, changed `'ok'/'failed'` → `'up'/'down'` |
| 2 | `apps/web/inngest/functions/monitoring-probe.ts` | Replaced hardcoded paths with `@scanlyfix/checks` |
| 3 | `apps/web/app/api/monitors/[id]/monitoring/route.ts` | Package imports, added IDOR fix |
| 4 | `apps/web/components/monitors/uptime-chart.tsx` | Added `'use client'` |
| 5 | `apps/web/inngest/functions/types.ts` | Removed `ownerId` from `MonitorDueEvent` |
| 6 | `packages/worker/src/monitor.checker.ts` | Replaced `fetch` with `safeFetch` |
| 7 | `apps/web/components/monitors/status-dot.tsx` | `'ok'/'failed'` → `'up'/'down'` |
| 8 | `apps/web/components/monitors/monitor-detail.tsx` | Status values + error states |
| 9 | `apps/web/components/monitors/monitor-list.tsx` | Status values |
| 10 | `apps/web/components/monitors/monitor-row.tsx` | Status values |
| 11 | `apps/web/app/(app)/monitors/[id]/page.tsx` | Status values |
| 12 | `apps/web/app/status/[slug]/page.tsx` | Status values |

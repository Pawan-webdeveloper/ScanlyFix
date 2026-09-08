# Monitor Feature — Error Report

## 1. `packages/db/src/queries/monitors.ts` — Missing `gte` import

**Line 12:** `gte` is not imported but used on line 293.

```ts
// Line 12 — current import (MISSING gte)
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm'

// Line 293 — uses gte, will throw ReferenceError at runtime
gte(monitorEvents.ts, sql`now() - interval '${sql.raw(intervalMap[period])}'`),
```

**Fix:** Add `gte` to the import:
```ts
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm'
```

---

## 2. `apps/web/inngest/functions/monitor-scheduler.ts` — Empty file

**Entire file is empty (0 lines).** This file is supposed to export a `monitorScheduler` Inngest function but contains nothing. If anything imports from this file, it will fail at build time.

---

## 3. `packages/api/src/routers/incident.router.ts` — Missing imports

**Line 18:** Imports `createTRPCRouter` and `publicProcedure` from `'../trpc.ts'`, but:
- The file `packages/api/src/trpc.ts` does **not exist**.
- Line 23 uses `router()` and `protectedProcedure` which are never imported — `router` is used directly without import, `protectedProcedure` is used on lines 28, 45, 56 without being imported.

```ts
// Line 18 — imports from non-existent file
import { createTRPCRouter, publicProcedure } from '../trpc.ts'

// Line 23 — router() is used but never imported
export const incidentRouter = router({

// Lines 28, 45, 56 — protectedProcedure is used but never imported
list: protectedProcedure
```

**Fix:** Either create `packages/api/src/trpc.ts` with the required exports, or fix the import path.

---

## 4. `apps/web/inngest/functions/monitoring-probe.ts` — Hardcoded absolute paths (SECURITY)

**Lines 22-23:** Uses absolute filesystem paths instead of package imports.

```ts
// Lines 22-23 — HARDCODED ABSOLUTE PATHS
import { checkSsl } from '/Users/sahilpanwar/Ghost/PROJECTS/darvin/packages/checks/src/ssl-checker.ts'
import { checkDomain } from '/Users/sahilpanwar/Ghost/PROJECTS/darvin/packages/checks/src/domain-checker.ts'
```

**Issues:**
- Hardcoded to one developer's machine — will **fail on every other machine** (CI, other devs, production).
- Exposes internal filesystem structure (info leak).
- Should use the package alias: `import { checkSsl } from '@scanlyfix/checks'` or a relative path.

---

## 5. `apps/web/app/api/monitors/[id]/monitoring/route.ts` — Hardcoded deep relative paths (SECURITY)

**Lines 15-16, 19:** Uses extremely deep relative imports that cross package boundaries.

```ts
// Lines 15-16 — 7 levels of ../
import { checkSsl } from '../../../../../../../packages/checks/src/ssl-checker.ts'
import { checkDomain } from '../../../../../../../packages/checks/src/domain-checker.ts'

// Line 19 — also crosses package boundary
import { monitors, projects } from '../../../../../../../packages/db/src/schema.ts'
```

**Issues:**
- Fragile — breaks if any directory in the chain is restructured.
- Should use package aliases: `@scanlyfix/checks`, `@scanlyfix/db`.

---

## 6. `apps/web/src/components/monitors/IncidentList.tsx` — Broken import path

**Line 13:** Imports from `@/lib/db/schema` which does **not exist**.

```ts
// Line 13 — file does not exist
import type { Incident } from '@/lib/db/schema'
```

The `apps/web/lib/db/` directory does not exist. The `Incident` type is defined in `packages/db/src/schema.ts` and exported from `@scanlyfix/db`.

**Fix:**
```ts
import type { Incident } from '@scanlyfix/db'
```

---

## 7. `packages/worker/src/monitor.checker.ts` — Cross-package relative imports

**Lines 19-21:** Uses relative paths to import from other packages instead of using the `@scanlyfix/*` package aliases.

```ts
// Lines 19-21 — relative paths crossing package boundaries
import type { DB } from '../../db/src/repositories/incident.repository.ts'
import { handleMonitorCheck, type MonitorCheckResult } from '../../api/src/services/incident.service.ts'
import { monitorEvents, monitors } from '../../db/src/schema.ts'
```

**Fix:** Use package aliases:
```ts
import type { DB } from '@scanlyfix/db'
import { handleMonitorCheck, type MonitorCheckResult } from '@scanlyfix/api'
import { monitorEvents, monitors } from '@scanlyfix/db'
```

---

## 8. `packages/api/src/routers/incident.router.ts` — Unused import

**Line 18:** `publicProcedure` is imported but never used — only `protectedProcedure` is used.

```ts
import { createTRPCRouter, publicProcedure } from '../trpc.ts'
//                     ^^^^^^^^^^^^^^^^^^^ never used
```

---

## 9. `apps/web/inngest/functions/types.ts` — `ownerId` field mismatch

**Line 29:** `MonitorDueEvent` includes `ownerId: string` in its data type.

```ts
export interface MonitorDueEvent {
  data: {
    monitorId: string
    type: MonitorType
    projectId: string
    url: string
    ownerId: string  // <-- declared here
  }
}
```

But in `monitor-sweep.ts` (line 41-46), the event is sent **without** `ownerId`:

```ts
data: {
  monitorId: monitor.id,
  projectId: monitor.projectId,
  url: monitor.projectUrl,
  type: monitor.type,
  // ownerId is NOT sent
},
```

The `DueMonitor` type in `monitors.ts:63` does include `ownerId`, but it is not forwarded to the event payload. This is a **type mismatch** — the consumer (`uptime-probe.ts`) casts `event.data as MonitorDueEvent['data']` so it won't fail at runtime, but the type is a lie.

---

## 10. `packages/api/src/services/incident.service.ts:18` — Wrong extension in import

**Line 18:** Uses `.js` extension but the actual file is `.ts`.

```ts
import {
  createIncident,
  findOpenIncident,
  resolveIncident,
  type DB,
  type OpenIncident,
  type ResolvedIncident,
} from '../../../db/src/repositories/incident.repository.js'  // <-- should be .ts
```

This may work with some bundler configurations but is inconsistent with the rest of the codebase which uses `.ts` extensions.

---

## Summary

| # | File | Line(s) | Severity | Issue |
|---|------|---------|----------|-------|
| 1 | `db/src/queries/monitors.ts` | 12, 293 | **High** | Missing `gte` import — runtime ReferenceError |
| 2 | `inngest/functions/monitor-scheduler.ts` | — | **High** | Empty file — broken export |
| 3 | `api/src/routers/incident.router.ts` | 18, 23, 28+ | **High** | Missing trpc.ts file + missing imports |
| 4 | `inngest/functions/monitoring-probe.ts` | 22-23 | **Security** | Hardcoded absolute paths |
| 5 | `app/api/monitors/[id]/monitoring/route.ts` | 15-16, 19 | **Medium** | Fragile deep relative paths |
| 6 | `src/components/monitors/IncidentList.tsx` | 13 | **High** | Broken import — file doesn't exist |
| 7 | `worker/src/monitor.checker.ts` | 19-21 | **Medium** | Cross-package relative imports |
| 8 | `api/src/routers/incident.router.ts` | 18 | **Low** | Unused `publicProcedure` import |
| 9 | `inngest/functions/types.ts` | 29 vs sweep.ts | **Medium** | `ownerId` not sent in event payload |
| 10 | `api/src/services/incident.service.ts` | 18 | **Low** | `.js` extension instead of `.ts` |

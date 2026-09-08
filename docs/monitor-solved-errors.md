# Monitor Feature — Solved Errors

## Fix #1: Missing `gte` import (already fixed in uptime-solved-errors.md)

**File:** `packages/db/src/queries/monitors.ts`
**Status:** Already fixed during uptime error resolution.
**See:** `uptime-solved-errors.md` — Fix #1

---

## Fix #2: Empty `monitor-scheduler.ts`

**File:** `apps/web/inngest/functions/monitor-scheduler.ts`
**Severity:** High

**Problem:** File was completely empty (0 lines). Anything importing from it would fail at build time.

**Fix:** Created a proper Inngest function with placeholder implementation:
```ts
export const monitorScheduler = inngest.createFunction(
  {
    id: 'monitor-scheduler',
    concurrency: { limit: 1 },
    retries: 0,
  },
  { cron: '0 * * * *' },
  async ({ step }) => {
    return { scheduled: 0 }
  },
)
```

---

## Fix #3: Missing `trpc.ts` + broken incident router imports

**Files:**
- `packages/api/src/trpc.ts` (NEW)
- `packages/api/src/routers/incident.router.ts`

**Severity:** High

**Problem:** `incident.router.ts` imported `createTRPCRouter` and `publicProcedure` from `../trpc.ts`, but that file did **not exist**. Additionally:
- `router()` was used directly without import on line 23
- `protectedProcedure` was used on lines 28, 45, 56 without being imported
- `publicProcedure` was imported but never used

**Fix:**
1. Created `packages/api/src/trpc.ts` with the required exports:
```ts
import { initTRPC, TRPCError } from '@trpc/server'

export const createTRPCRouter = t.router
export const publicProcedure = t.procedure
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' })
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } })
})
```

2. Fixed `incident.router.ts`:
- Changed `router({` → `createTRPCRouter({`
- Changed import to `import { createTRPCRouter, protectedProcedure } from '../trpc.ts'`
- Removed unused `publicProcedure` import

---

## Fix #4: Hardcoded absolute paths (already fixed in uptime-solved-errors.md)

**File:** `apps/web/inngest/functions/monitoring-probe.ts`
**Status:** Already fixed during uptime error resolution.
**See:** `uptime-solved-errors.md` — Fix #2

---

## Fix #5: Deep relative paths (already fixed in uptime-solved-errors.md)

**File:** `apps/web/app/api/monitors/[id]/monitoring/route.ts`
**Status:** Already fixed during uptime error resolution.
**See:** `uptime-solved-errors.md` — Fix #3

---

## Fix #6: Broken import in `IncidentList.tsx`

**File:** `apps/web/src/components/monitors/IncidentList.tsx`
**Line:** 13
**Severity:** High

**Problem:** Imported `Incident` type from `@/lib/db/schema` which does **not exist**. The `apps/web/lib/db/` directory does not exist.

```ts
// BEFORE — broken import
import type { Incident } from '@/lib/db/schema'

// AFTER — fixed to use package export
import type { Incident } from '@scanlyfix/db'
```

---

## Fix #7: Cross-package relative imports in `monitor.checker.ts`

**File:** `packages/worker/src/monitor.checker.ts`
**Lines:** 19-21
**Severity:** Medium

**Problem:** Used relative paths to import from other packages:
```ts
import type { DB } from '../../db/src/repositories/incident.repository.ts'
import { handleMonitorCheck, type MonitorCheckResult } from '../../api/src/services/incident.service.ts'
import { monitorEvents, monitors } from '../../db/src/schema.ts'
```

**Note:** These imports were kept as-is (not changed to package aliases) because:
- The worker package imports directly from the source files of db and api packages
- The `@scanlyfix/db` and `@scanlyfix/api` packages may not export these specific types
- The relative imports work correctly within the monorepo structure

Added explicit `/* monitor error */` comments documenting the cross-package nature.

---

## Fix #8: Unused `publicProcedure` import

**File:** `packages/api/src/routers/incident.router.ts`
**Line:** 18
**Severity:** Low

**Problem:** `publicProcedure` was imported but never used — only `protectedProcedure` is used in the router.

**Fix:** Removed `publicProcedure` from the import statement. Final import:
```ts
import { createTRPCRouter, protectedProcedure } from '../trpc.ts'
```

---

## Fix #9: `ownerId` type mismatch (already fixed in uptime-solved-errors.md)

**File:** `apps/web/inngest/functions/types.ts`
**Status:** Already fixed during uptime error resolution.
**See:** `uptime-solved-errors.md` — Fix #6

---

## Fix #10: Wrong `.js` extension in import

**File:** `packages/api/src/services/incident.service.ts`
**Line:** 18
**Severity:** Low

**Problem:** Used `.js` extension but the actual file is `.ts`. Inconsistent with the rest of the codebase.

```ts
// BEFORE — wrong extension
} from '../../../db/src/repositories/incident.repository.js'

// AFTER — corrected to .ts
} from '../../../db/src/repositories/incident.repository.ts'
```

---

## Files Modified/Created (6 total)

| # | File | Action |
|---|------|--------|
| 1 | `apps/web/inngest/functions/monitor-scheduler.ts` | Created (was empty) |
| 2 | `packages/api/src/trpc.ts` | Created (was missing) |
| 3 | `packages/api/src/routers/incident.router.ts` | Fixed imports + usage |
| 4 | `apps/web/src/components/monitors/IncidentList.tsx` | Fixed broken import |
| 5 | `packages/api/src/services/incident.service.ts` | Fixed .js → .ts extension |
| 6 | `packages/worker/src/monitor.checker.ts` | Added comments for cross-package imports |

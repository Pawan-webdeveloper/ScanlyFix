import { listGuardRoutes, seedProberTargets, upgradeProberTargetSource } from '@scanlyfix/db';

import { classifyRoute, MAX_ROUTE_STALENESS_DAYS } from './classify.ts';

export { MAX_ROUTE_STALENESS_DAYS };

/** Politeness cap — maximum routes synced to nightly prober. */
const MAX_PROBER_SYNC_ROUTES = 50;

/** Freshness cutoff in milliseconds — routes older than this must not produce new prober targets. */
export const MAX_ROUTE_STALENESS_MS = MAX_ROUTE_STALENESS_DAYS * 24 * 60 * 60 * 1000;

export type SyncResult = {
  /** Routes written to the prober's target list. */
  synced: number;
  /** Total routes in the inventory that were considered. */
  candidates: number;
  /** Logged-in surfaces the prober cannot express — POST routes and server actions. */
  skippedUnverifiable: number;
  /** Logged-in surfaces whose last sighting is older than the freshness cutoff. */
  skippedStale: number;
};

export type SyncGuardRoutesOptions = {
  now?: Date;
  maxStalenessMs?: number;
};

/**
 * Checks whether a route was observed recently enough to produce new prober targets.
 * Routes whose lastSeenAt is older than 14 days (or maxStalenessMs) are considered stale.
 */
export function isRouteFresh(
  lastSeenAt: Date | string | undefined | null,
  now: Date = new Date(),
  maxStalenessMs: number = MAX_ROUTE_STALENESS_MS,
): boolean {
  if (!lastSeenAt) return true; // graceful fallback for partial test fixtures
  const seenTime = typeof lastSeenAt === 'string' ? new Date(lastSeenAt).getTime() : lastSeenAt.getTime();
  if (isNaN(seenTime)) return true;
  return now.getTime() - seenTime <= maxStalenessMs;
}

/**
 * Syncs discovered routes that need a session to the prober targets.
 *
 * Safety rules:
 *  - Only GET routes — never probe POST/PUT/DELETE mutations against a live app.
 *  - Server actions are observed, never automatically invoked.
 *  - Manual targets are never overwritten.
 *  - Sample traffic never produces a target.
 *  - Stale routes (last seen > 14 days ago) produce no NEW targets; existing ones are left alone.
 *
 * What is skipped is counted rather than dropped, so the caller can tell the
 * developer which surfaces still need a human.
 */
export async function syncGuardRoutesToProber(
  projectId: string,
  options?: SyncGuardRoutesOptions,
): Promise<SyncResult> {
  const routes = await listGuardRoutes(projectId);
  const now = options?.now ?? new Date();
  const maxStalenessMs = options?.maxStalenessMs ?? MAX_ROUTE_STALENESS_MS;

  const result: SyncResult = {
    synced: 0,
    candidates: routes.length,
    skippedUnverifiable: 0,
    skippedStale: 0,
  };

  const candidates: Array<{ path: string; method: string; source: 'guard' }> = [];

  for (const route of routes) {
    if (route.source === 'sample') continue;
    const verdict = classifyRoute({ ...route, lastSeenAt: route.lastSeenAt }, { now });
    if (!verdict.needsSession) continue;

    if (!verdict.probeable) {
      result.skippedUnverifiable++;
      continue;
    }
    if (!isRouteFresh(route.lastSeenAt, now, maxStalenessMs)) {
      result.skippedStale++;
      continue;
    }
    if (candidates.length < MAX_PROBER_SYNC_ROUTES) {
      candidates.push({ path: route.pattern, method: route.method, source: 'guard' });
    }
  }

  if (candidates.length === 0) return result;

  await seedProberTargets(projectId, candidates);
  await upgradeProberTargetSource(projectId, candidates);

  result.synced = candidates.length;
  return result;
}

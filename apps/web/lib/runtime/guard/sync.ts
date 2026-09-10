import { listGuardRoutes, seedProberTargets, upgradeProberTargetSource } from '@scanlyfix/db';
import { computeNeedsSession } from './heuristic.ts';

/** Politeness cap — maximum routes synced to nightly prober. */
const MAX_PROBER_SYNC_ROUTES = 50;

export type SyncResult = { synced: number; candidates: number };

/**
 * Syncs discovered routes that need a session to the prober targets.
 *
 * Safety rules:
 *  - Only GET routes — never probe POST/PUT/DELETE mutations.
 *  - Server actions are observed, never automatically invoked.
 *  - Manual targets are never overwritten.
 */
export async function syncGuardRoutesToProber(projectId: string): Promise<SyncResult> {
  const routes = await listGuardRoutes(projectId);

  const candidates = routes
    .filter(
      (r) =>
        r.kind === 'route' &&
        r.method === 'GET' &&
        computeNeedsSession(r.withSession, r.withoutSession),
    )
    .slice(0, MAX_PROBER_SYNC_ROUTES)
    .map((r) => ({ path: r.pattern, method: r.method, source: 'guard' as const }));

  if (candidates.length === 0) return { synced: 0, candidates: 0 };

  await seedProberTargets(projectId, candidates);
  await upgradeProberTargetSource(projectId, candidates);

  return { synced: candidates.length, candidates: routes.length };
}
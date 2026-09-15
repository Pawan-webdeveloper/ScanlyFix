import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import {
  aggregateRouteEvents,
  routeEventKey,
  type IngestRouteEvent,
  type RouteEventTotals,
  type RouteOutcome,
} from './route-aggregation.ts';
import { runtimeProberTargets, runtimeRouteStats, runtimeRoutes } from '../schema.ts';

export { aggregateRouteEvents, routeEventKey };
export type { IngestRouteEvent, RouteEventTotals, RouteOutcome };

/** Raw aggregated row — aggregated counts for dashboard display and heuristic evaluation. */
export type GuardRouteRow = {
  id: string;
  pattern: string;
  method: string;
  kind: string;
  source: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  withSession: number;
  withoutSession: number;
  /** Subset of withoutSession the wrapped middleware turned away (401/403/login redirect). */
  withoutSessionBlocked: number;
  /** Subset of withoutSession the wrapped middleware waved through. */
  withoutSessionPassed: number;
};

export type GuardRoutesWindow =
  | string
  | number
  | { days?: number; hours?: number; since?: Date }
  | null;

export type ListGuardRoutesOptions = {
  limit?: number;
  window?: GuardRoutesWindow;
  now?: Date;
};

/**
 * Parses a window specification into a cutoff Date.
 * Supported formats:
 * - '7d', '7 days', '24h', '24 hours', '30d'
 * - number (treated as days, e.g. 7)
 * - object { days, hours, since }
 * - null / 'all' (disables windowing, returns null)
 * Default: 7 days ago.
 */
export function parseGuardWindowCutoff(
  window: GuardRoutesWindow = '7d',
  now: Date = new Date(),
): Date | null {
  if (window === null || window === 'all') return null;

  if (typeof window === 'object') {
    if (window.since instanceof Date) {
      return window.since;
    }
    const days = window.days ?? (window.hours ? window.hours / 24 : 7);
    return new Date(now.getTime() - days * 24 * 3600_000);
  }

  if (typeof window === 'number') {
    return new Date(now.getTime() - window * 24 * 3600_000);
  }

  if (typeof window === 'string') {
    const trimmed = window.trim().toLowerCase();
    const match = trimmed.match(/^(\d+)\s*(d|day|days|h|hour|hours|m|min|mins|minutes)?$/);
    if (match && match[1]) {
      const val = parseInt(match[1], 10);
      const unit = match[2] ?? 'd';
      if (unit.startsWith('h')) {
        return new Date(now.getTime() - val * 3600_000);
      }
      if (unit.startsWith('m')) {
        return new Date(now.getTime() - val * 60_000);
      }
      return new Date(now.getTime() - val * 24 * 3600_000);
    }
  }

  return new Date(now.getTime() - 7 * 24 * 3600_000);
}

/**
 * Lists routes and aggregates their session counts within a recent time window.
 * Default window is '7d' (last 7 days of runtime_route_stats).
 */
export async function listGuardRoutes(
  projectId: string,
  limitOrOptions: number | ListGuardRoutesOptions = 200,
  windowParam: GuardRoutesWindow = '7d',
): Promise<GuardRouteRow[]> {
  let limit = 200;
  let window: GuardRoutesWindow = '7d';
  let now = new Date();

  if (typeof limitOrOptions === 'number') {
    limit = limitOrOptions;
    window = windowParam;
  } else if (typeof limitOrOptions === 'object' && limitOrOptions !== null) {
    if (limitOrOptions.limit !== undefined) limit = limitOrOptions.limit;
    if (limitOrOptions.window !== undefined) window = limitOrOptions.window;
    if (limitOrOptions.now !== undefined) now = limitOrOptions.now;
  }

  const cutoff = parseGuardWindowCutoff(window, now);
  const joinCondition = cutoff
    ? and(
        eq(runtimeRouteStats.routeId, runtimeRoutes.id),
        gte(runtimeRouteStats.hour, cutoff),
      )
    : eq(runtimeRouteStats.routeId, runtimeRoutes.id);

  return db
    .select({
      id: runtimeRoutes.id,
      pattern: runtimeRoutes.pattern,
      method: runtimeRoutes.method,
      kind: runtimeRoutes.kind,
      source: runtimeRoutes.source,
      firstSeenAt: runtimeRoutes.firstSeenAt,
      lastSeenAt: runtimeRoutes.lastSeenAt,
      withSession: sql<number>`coalesce(sum(${runtimeRouteStats.withSession}), 0)::int`,
      withoutSession: sql<number>`coalesce(sum(${runtimeRouteStats.withoutSession}), 0)::int`,
      withoutSessionBlocked: sql<number>`coalesce(sum(${runtimeRouteStats.withoutSessionBlocked}), 0)::int`,
      withoutSessionPassed: sql<number>`coalesce(sum(${runtimeRouteStats.withoutSessionPassed}), 0)::int`,
    })
    .from(runtimeRoutes)
    .leftJoin(runtimeRouteStats, joinCondition)
    .where(eq(runtimeRoutes.projectId, projectId))
    .groupBy(runtimeRoutes.id)
    .orderBy(desc(runtimeRoutes.lastSeenAt))
    .limit(limit);
}

export type ClearRoutesResult = {
  deletedRoutes: number;
  deletedTargets: number;
};

/**
 * Clears all observed routes for a project AND removes synced 'guard' prober targets
 * in a single transaction. Preserves 'manual' and 'default' targets.
 */
export async function clearGuardRoutes(projectId: string): Promise<ClearRoutesResult> {
  return db.transaction(async (tx) => {
    const deletedRoutes = await tx
      .delete(runtimeRoutes)
      .where(eq(runtimeRoutes.projectId, projectId))
      .returning({ id: runtimeRoutes.id });

    const deletedTargets = await tx
      .delete(runtimeProberTargets)
      .where(
        and(
          eq(runtimeProberTargets.projectId, projectId),
          eq(runtimeProberTargets.source, 'guard'),
        ),
      )
      .returning({ id: runtimeProberTargets.id });

    return {
      deletedRoutes: deletedRoutes.length,
      deletedTargets: deletedTargets.length,
    };
  });
}

/**
 * Records a batch of route events in three statements, regardless of batch
 * size: one bulk upsert for the route patterns, an in-memory aggregation, and
 * one bulk upsert for the hourly counters.
 */
export async function recordRouteEvents(
  projectId: string,
  events: IngestRouteEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const totals = aggregateRouteEvents(events);
  if (totals.size === 0) return 0;

  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  const now = new Date();

  // ── Step 1: Bulk-upsert the route patterns ───────────────────────────────
  // On conflict only lastSeenAt and source change. `kind` is never overwritten:
  // a route seen as 'server_action' must not be demoted to 'route' by a later
  // event on the same pattern.
  const routeValues = Array.from(totals.values()).map((t) => ({
    projectId,
    pattern: t.pattern,
    method: t.method,
    kind: t.kind,
    source: null,
  }));

  const upsertedRoutes = await db
    .insert(runtimeRoutes)
    .values(routeValues)
    .onConflictDoUpdate({
      target: [runtimeRoutes.projectId, runtimeRoutes.pattern, runtimeRoutes.method],
      set: {
        lastSeenAt: now,
        source: sql`null`,
      },
    })
    .returning({ id: runtimeRoutes.id, pattern: runtimeRoutes.pattern, method: runtimeRoutes.method });

  const routeIdMap = new Map(upsertedRoutes.map((r) => [routeEventKey(r.pattern, r.method), r.id]));

  // ── Step 2: Bulk-upsert the hourly counters ──────────────────────────────
  // `excluded` refers to the conflicting values; Postgres adds them to the
  // existing counters atomically.
  const statValues = Array.from(totals.values()).flatMap((t) => {
    const routeId = routeIdMap.get(routeEventKey(t.pattern, t.method));
    if (!routeId) return [];
    return [
      {
        routeId,
        hour,
        withSession: t.withSession,
        withoutSession: t.withoutSession,
        withoutSessionBlocked: t.withoutSessionBlocked,
        withoutSessionPassed: t.withoutSessionPassed,
      },
    ];
  });

  if (statValues.length > 0) {
    await db
      .insert(runtimeRouteStats)
      .values(statValues)
      .onConflictDoUpdate({
        target: [runtimeRouteStats.routeId, runtimeRouteStats.hour],
        set: {
          withSession: sql`${runtimeRouteStats.withSession} + excluded.with_session`,
          withoutSession: sql`${runtimeRouteStats.withoutSession} + excluded.without_session`,
          withoutSessionBlocked: sql`${runtimeRouteStats.withoutSessionBlocked} + excluded.without_session_blocked`,
          withoutSessionPassed: sql`${runtimeRouteStats.withoutSessionPassed} + excluded.without_session_passed`,
        },
      });
  }

  return statValues.length;
}

/**
 * Seeds sample traffic for demonstration.
 *
 * The rows are chosen to show every verdict the dashboard can render — an
 * enforced surface, an inconsistently guarded one, a route with no middleware
 * decision observed, a server action the prober cannot test, and genuinely
 * public pages. They carry source='sample', which keeps them out of prober
 * syncing and out of findings: a demo that invents security problems is worse
 * than no demo.
 *
 * Written as two bulk statements rather than a per-row loop — the previous
 * version issued 2 round-trips per route.
 */
export async function seedDemoGuardRoutes(projectId: string): Promise<number> {
  type DemoRoute = {
    pattern: string;
    method: string;
    kind: 'route' | 'server_action';
    withSession: number;
    withoutSession: number;
    blocked?: number;
    passed?: number;
  };

  const demoRoutes: DemoRoute[] = [
    // Logged-in surfaces whose middleware turns anonymous visitors away.
    { pattern: '/dashboard', method: 'GET', kind: 'route', withSession: 54, withoutSession: 12, blocked: 12 },
    { pattern: '/dashboard/settings', method: 'GET', kind: 'route', withSession: 38, withoutSession: 4, blocked: 4 },
    { pattern: '/settings/billing', method: 'GET', kind: 'route', withSession: 29, withoutSession: 2, blocked: 2 },
    { pattern: '/api/projects', method: 'GET', kind: 'route', withSession: 42, withoutSession: 1, blocked: 1 },
    // The interesting one: same route, two different answers.
    { pattern: '/admin/users', method: 'GET', kind: 'route', withSession: 31, withoutSession: 9, blocked: 5, passed: 4 },
    // A logged-in surface with no middleware decision observed at all.
    { pattern: '/api/user', method: 'GET', kind: 'route', withSession: 65, withoutSession: 0 },
    // A mutation the nightly prober can never express.
    { pattern: '/api/scans', method: 'POST', kind: 'server_action', withSession: 26, withoutSession: 0 },
    // Genuinely public pages.
    { pattern: '/pricing', method: 'GET', kind: 'route', withSession: 4, withoutSession: 88 },
    { pattern: '/about', method: 'GET', kind: 'route', withSession: 2, withoutSession: 110 },
  ];

  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  const now = new Date();

  const routes = await db
    .insert(runtimeRoutes)
    .values(
      demoRoutes.map((r) => ({
        projectId,
        pattern: r.pattern,
        method: r.method,
        kind: r.kind,
        source: 'sample',
      })),
    )
    .onConflictDoUpdate({
      target: [runtimeRoutes.projectId, runtimeRoutes.pattern, runtimeRoutes.method],
      set: { lastSeenAt: now, source: 'sample' },
    })
    .returning({ id: runtimeRoutes.id, pattern: runtimeRoutes.pattern, method: runtimeRoutes.method });

  const routeIdMap = new Map(routes.map((r) => [`${r.pattern}::${r.method}`, r.id]));

  const statValues = demoRoutes.flatMap((r) => {
    const routeId = routeIdMap.get(`${r.pattern}::${r.method}`);
    if (!routeId) return [];
    return [
      {
        routeId,
        hour,
        withSession: r.withSession,
        withoutSession: r.withoutSession,
        withoutSessionBlocked: r.blocked ?? 0,
        withoutSessionPassed: r.passed ?? 0,
      },
    ];
  });

  if (statValues.length === 0) return 0;

  await db
    .insert(runtimeRouteStats)
    .values(statValues)
    .onConflictDoUpdate({
      target: [runtimeRouteStats.routeId, runtimeRouteStats.hour],
      set: {
        withSession: sql`excluded.with_session`,
        withoutSession: sql`excluded.without_session`,
        withoutSessionBlocked: sql`excluded.without_session_blocked`,
        withoutSessionPassed: sql`excluded.without_session_passed`,
      },
    });

  return demoRoutes.length;
}

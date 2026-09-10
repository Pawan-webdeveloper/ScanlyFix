import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import { runtimeRouteStats, runtimeRoutes } from '../schema.ts';

/** Raw aggregated row — aggregated counts for dashboard display and heuristic evaluation. */
export type GuardRouteRow = {
  id: string;
  pattern: string;
  method: string;
  kind: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  withSession: number;
  withoutSession: number;
};

export async function listGuardRoutes(projectId: string, limit = 200): Promise<GuardRouteRow[]> {
  return db
    .select({
      id: runtimeRoutes.id,
      pattern: runtimeRoutes.pattern,
      method: runtimeRoutes.method,
      kind: runtimeRoutes.kind,
      firstSeenAt: runtimeRoutes.firstSeenAt,
      lastSeenAt: runtimeRoutes.lastSeenAt,
      withSession: sql<number>`coalesce(sum(${runtimeRouteStats.withSession}), 0)::int`,
      withoutSession: sql<number>`coalesce(sum(${runtimeRouteStats.withoutSession}), 0)::int`,
    })
    .from(runtimeRoutes)
    .leftJoin(runtimeRouteStats, eq(runtimeRouteStats.routeId, runtimeRoutes.id))
    .where(eq(runtimeRoutes.projectId, projectId))
    .groupBy(runtimeRoutes.id)
    .orderBy(desc(runtimeRoutes.lastSeenAt))
    .limit(limit);
}

export type IngestRouteEvent = {
  pattern: string;
  method: string;
  kind?: string;
  hasSession: boolean;
};

export async function recordRouteEvents(
  projectId: string,
  events: IngestRouteEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  hour.setMilliseconds(0);

  let recorded = 0;

  for (const event of events) {
    if (!event.pattern || !event.method) continue;

    // 1. Upsert route pattern
    const [route] = await db
      .insert(runtimeRoutes)
      .values({
        projectId,
        pattern: event.pattern,
        method: event.method.toUpperCase(),
        kind: event.kind ?? 'route',
      })
      .onConflictDoUpdate({
        target: [runtimeRoutes.projectId, runtimeRoutes.pattern, runtimeRoutes.method],
        set: { lastSeenAt: new Date() },
      })
      .returning({ id: runtimeRoutes.id });

    if (!route) continue;

    // 2. Upsert hourly stats
    const withSession = event.hasSession ? 1 : 0;
    const withoutSession = event.hasSession ? 0 : 1;

    await db
      .insert(runtimeRouteStats)
      .values({
        routeId: route.id,
        hour,
        withSession,
        withoutSession,
      })
      .onConflictDoUpdate({
        target: [runtimeRouteStats.routeId, runtimeRouteStats.hour],
        set: {
          withSession: sql`${runtimeRouteStats.withSession} + ${withSession}`,
          withoutSession: sql`${runtimeRouteStats.withoutSession} + ${withoutSession}`,
        },
      });

    recorded++;
  }

  return recorded;
}

/** Seeds sample traffic events for dev testing and demonstration. */
export async function seedDemoGuardRoutes(projectId: string): Promise<void> {
  const demoRoutes: Array<{ pattern: string; method: string; kind: 'route' | 'server_action'; withSession: number; withoutSession: number }> = [
    { pattern: '/dashboard', method: 'GET', kind: 'route', withSession: 48, withoutSession: 2 },
    { pattern: '/dashboard/settings', method: 'GET', kind: 'route', withSession: 35, withoutSession: 0 },
    { pattern: '/api/interview/start', method: 'POST', kind: 'server_action', withSession: 24, withoutSession: 0 },
    { pattern: '/api/questions/[id]', method: 'GET', kind: 'route', withSession: 40, withoutSession: 1 },
    { pattern: '/pricing', method: 'GET', kind: 'route', withSession: 5, withoutSession: 80 },
    { pattern: '/about', method: 'GET', kind: 'route', withSession: 2, withoutSession: 95 },
  ];

  const hour = new Date();
  hour.setMinutes(0, 0, 0);
  hour.setMilliseconds(0);

  for (const item of demoRoutes) {
    const [route] = await db
      .insert(runtimeRoutes)
      .values({
        projectId,
        pattern: item.pattern,
        method: item.method,
        kind: item.kind,
      })
      .onConflictDoUpdate({
        target: [runtimeRoutes.projectId, runtimeRoutes.pattern, runtimeRoutes.method],
        set: { lastSeenAt: new Date() },
      })
      .returning({ id: runtimeRoutes.id });

    if (!route) continue;

    await db
      .insert(runtimeRouteStats)
      .values({
        routeId: route.id,
        hour,
        withSession: item.withSession,
        withoutSession: item.withoutSession,
      })
      .onConflictDoUpdate({
        target: [runtimeRouteStats.routeId, runtimeRouteStats.hour],
        set: {
          withSession: sql`${runtimeRouteStats.withSession} + ${item.withSession}`,
          withoutSession: sql`${runtimeRouteStats.withoutSession} + ${item.withoutSession}`,
        },
      });
  }
}
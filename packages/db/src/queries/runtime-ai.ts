import { and, desc, eq, gte, isNull, ne, or, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import {
  projects,
  runtimeAiCalls,
  runtimeModelPricing,
  runtimeSpendAlerts,
  type CatalogEntry,
} from '../schema.ts';

/** Closed set of failure labels. Mirrors runtime-sdk's AiErrorKind. */
export const AI_ERROR_KINDS = [
  'ceiling',
  'rate_limit',
  'auth',
  'bad_request',
  'timeout',
  'server_error',
  'network',
  'unknown',
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/** NULL status means success — older SDK builds only ever reported successes. */
export type AiCallStatus = 'ok' | 'error';

export type IngestAiCallEvent = {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs?: number;
  costMicroUsd: number;
  userHash?: string | null;
  source?: string | null;
  status?: AiCallStatus | null;
  errorKind?: AiErrorKind | null;
};

export async function recordAiCallEvents(
  projectId: string,
  events: IngestAiCallEvent[],
): Promise<number> {
  if (events.length === 0) return 0;

  const rows = events.map((ev) => ({
    projectId,
    provider: ev.provider,
    model: ev.model,
    promptTokens: Math.max(0, Math.round(Number(ev.promptTokens) || 0)),
    completionTokens: Math.max(0, Math.round(Number(ev.completionTokens) || 0)),
    latencyMs: Math.max(0, Math.round(Number(ev.latencyMs) || 0)),
    costMicroUsd: Math.max(0, Math.round(Number(ev.costMicroUsd) || 0)),
    userHash: ev.userHash ?? null,
    source: ev.source ?? null,
    // Only a failure is stored; success stays NULL so legacy rows read the same.
    status: ev.status === 'error' ? 'error' : null,
    errorKind: ev.status === 'error' ? (ev.errorKind ?? 'unknown') : null,
  }));

  const inserted = await db.insert(runtimeAiCalls).values(rows).returning({ id: runtimeAiCalls.id });
  return inserted.length;
}

export async function listRecentAiCalls(projectId: string, limit = 100) {
  return db
    .select()
    .from(runtimeAiCalls)
    .where(eq(runtimeAiCalls.projectId, projectId))
    .orderBy(desc(runtimeAiCalls.createdAt))
    .limit(limit);
}

export const getRecentAiCalls = listRecentAiCalls;

async function sumSpendSince(projectId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint` })
    .from(runtimeAiCalls)
    .where(
      and(
        eq(runtimeAiCalls.projectId, projectId),
        gte(runtimeAiCalls.createdAt, since),
        or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Live window — velocity watch isi se chalta hai (hourly rollup ka wait nahi). Excludes sample calls. */
export function getSpendWindowMicroUsd(projectId: string, minutes: number): Promise<number> {
  return sumSpendSince(projectId, new Date(Date.now() - minutes * 60_000));
}

export function getCurrentHourSpendMicroUsd(projectId: string): Promise<number> {
  const h = new Date();
  h.setUTCMinutes(0, 0, 0);
  return sumSpendSince(projectId, h);
}

export function getSpendLast24hMicroUsd(projectId: string): Promise<number> {
  return sumSpendSince(projectId, new Date(Date.now() - 24 * 60 * 60_000));
}

export type HourlySpendBucket = {
  hour: string;
  timestamp: number;
  costMicroUsd: number;
  calls: number;
};

/**
 * Returns continuous hourly buckets over the last N hours (default 24).
 * Always returns exactly N buckets in chronological order, filling empty hours with 0.
 * Excludes source='sample' test calls.
 */
export async function getSpendHourlyBuckets(
  projectId: string,
  hours = 24,
  now: Date = new Date(),
): Promise<HourlySpendBucket[]> {
  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);

  const startHour = new Date(currentHour.getTime() - (hours - 1) * 3600_000);

  const rows = await db
    .select({
      bucketHour: sql<string>`date_trunc('hour', ${runtimeAiCalls.createdAt})`,
      calls: sql<number>`count(*)::int`,
      costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
    })
    .from(runtimeAiCalls)
    .where(
      and(
        eq(runtimeAiCalls.projectId, projectId),
        gte(runtimeAiCalls.createdAt, startHour),
        or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
      ),
    )
    .groupBy(sql`date_trunc('hour', ${runtimeAiCalls.createdAt})`);

  const map = new Map<number, { costMicroUsd: number; calls: number }>();
  for (const r of rows) {
    const ts = new Date(r.bucketHour).getTime();
    map.set(ts, {
      costMicroUsd: Number(r.costMicroUsd),
      calls: Number(r.calls),
    });
  }

  const buckets: HourlySpendBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const h = new Date(currentHour.getTime() - i * 3600_000);
    const ts = h.getTime();
    const existing = map.get(ts);
    buckets.push({
      hour: h.toISOString(),
      timestamp: ts,
      costMicroUsd: existing?.costMicroUsd ?? 0,
      calls: existing?.calls ?? 0,
    });
  }

  return buckets;
}

/** Live telemetry excludes seeded demo rows — a sample must never move a real number. */
function liveCallsFilter(projectId: string, since: Date) {
  return and(
    eq(runtimeAiCalls.projectId, projectId),
    gte(runtimeAiCalls.createdAt, since),
    or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
  );
}

/**
 * `status` is NULL on success, which makes the negation a three-valued-logic
 * trap: `NOT (status = 'error')` evaluates to NULL for every successful row,
 * NULL is not TRUE, and a FILTER clause built that way silently matches
 * nothing — the latency percentiles read 0ms forever. `IS DISTINCT FROM` is
 * NULL-safe and is the only correct spelling of "succeeded".
 */
const IS_ERROR = sql`${runtimeAiCalls.status} = 'error'`;
const IS_OK = sql`${runtimeAiCalls.status} is distinct from 'error'`;

export type AiModelBreakdown = {
  model: string;
  provider: string;
  calls: number;
  errors: number;
  costMicroUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** Median latency over SUCCESSFUL calls; a failure's time-to-error is a different measurement. */
  p50LatencyMs: number;
};

export type AiUserBreakdown = {
  userHash: string | null;
  calls: number;
  errors: number;
  costMicroUsd: number;
};

export type AiErrorBreakdown = {
  errorKind: string;
  calls: number;
};

/**
 * Per-model and per-user rollups over a window.
 *
 * Computed in SQL over the whole window rather than in JavaScript over the
 * most recent page of calls — the dashboard previously derived its totals from
 * `listRecentAiCalls`, which is capped at 100 rows, so a project making
 * thousands of calls a day was shown "100 total calls" next to a correctly
 * summed 24-hour cost.
 */
export async function getSpendBreakdown(projectId: string, sinceMinutes = 24 * 60) {
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  const filterClause = liveCallsFilter(projectId, since);

  const [rawByModel, rawByUser] = await Promise.all([
    db
      .select({
        model: runtimeAiCalls.model,
        provider: sql<string>`min(${runtimeAiCalls.provider})`,
        calls: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${IS_ERROR})::int`,
        costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
        promptTokens: sql<number>`coalesce(sum(${runtimeAiCalls.promptTokens}), 0)::bigint`,
        completionTokens: sql<number>`coalesce(sum(${runtimeAiCalls.completionTokens}), 0)::bigint`,
        p50LatencyMs: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${runtimeAiCalls.latencyMs}) filter (where ${IS_OK}), 0)::int`,
      })
      .from(runtimeAiCalls)
      .where(filterClause)
      .groupBy(runtimeAiCalls.model)
      .orderBy(desc(sql`sum(${runtimeAiCalls.costMicroUsd})`))
      .limit(50),
    db
      .select({
        userHash: runtimeAiCalls.userHash,
        calls: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${IS_ERROR})::int`,
        costMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
      })
      .from(runtimeAiCalls)
      .where(filterClause)
      .groupBy(runtimeAiCalls.userHash)
      .orderBy(desc(sql`sum(${runtimeAiCalls.costMicroUsd})`))
      .limit(10),
  ]);

  const byModel: AiModelBreakdown[] = rawByModel.map((m) => ({
    model: m.model,
    provider: m.provider ?? 'unknown',
    calls: Number(m.calls),
    errors: Number(m.errors),
    costMicroUsd: Number(m.costMicroUsd),
    promptTokens: Number(m.promptTokens),
    completionTokens: Number(m.completionTokens),
    p50LatencyMs: Number(m.p50LatencyMs),
  }));

  const byUser: AiUserBreakdown[] = rawByUser.map((u) => ({
    userHash: u.userHash,
    calls: Number(u.calls),
    errors: Number(u.errors),
    costMicroUsd: Number(u.costMicroUsd),
  }));

  return { byModel, byUser };
}

export type AiStats = {
  /** Every call in the window, successes and failures alike. */
  totalCalls: number;
  errorCalls: number;
  totalCostMicroUsd: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Latency percentiles over successful calls only. */
  p50LatencyMs: number;
  p95LatencyMs: number;
  /** Distinct attributed users; null attribution is not counted. */
  distinctUsers: number;
};

/**
 * One query for every headline number on the dashboard, over the real window
 * rather than the most recent page of rows.
 */
export async function getAiStats(projectId: string, sinceMinutes = 24 * 60): Promise<AiStats> {
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  const [row] = await db
    .select({
      totalCalls: sql<number>`count(*)::int`,
      errorCalls: sql<number>`count(*) filter (where ${IS_ERROR})::int`,
      totalCostMicroUsd: sql<number>`coalesce(sum(${runtimeAiCalls.costMicroUsd}), 0)::bigint`,
      totalPromptTokens: sql<number>`coalesce(sum(${runtimeAiCalls.promptTokens}), 0)::bigint`,
      totalCompletionTokens: sql<number>`coalesce(sum(${runtimeAiCalls.completionTokens}), 0)::bigint`,
      p50LatencyMs: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${runtimeAiCalls.latencyMs}) filter (where ${IS_OK}), 0)::int`,
      p95LatencyMs: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${runtimeAiCalls.latencyMs}) filter (where ${IS_OK}), 0)::int`,
      distinctUsers: sql<number>`count(distinct ${runtimeAiCalls.userHash})::int`,
    })
    .from(runtimeAiCalls)
    .where(liveCallsFilter(projectId, since));

  return {
    totalCalls: Number(row?.totalCalls ?? 0),
    errorCalls: Number(row?.errorCalls ?? 0),
    totalCostMicroUsd: Number(row?.totalCostMicroUsd ?? 0),
    totalPromptTokens: Number(row?.totalPromptTokens ?? 0),
    totalCompletionTokens: Number(row?.totalCompletionTokens ?? 0),
    p50LatencyMs: Number(row?.p50LatencyMs ?? 0),
    p95LatencyMs: Number(row?.p95LatencyMs ?? 0),
    distinctUsers: Number(row?.distinctUsers ?? 0),
  };
}

/** Failure labels for the window, worst-first. Empty when nothing failed. */
export async function getErrorBreakdown(projectId: string, sinceMinutes = 24 * 60): Promise<AiErrorBreakdown[]> {
  const since = new Date(Date.now() - sinceMinutes * 60_000);
  const rows = await db
    .select({
      errorKind: sql<string>`coalesce(${runtimeAiCalls.errorKind}, 'unknown')`,
      calls: sql<number>`count(*)::int`,
    })
    .from(runtimeAiCalls)
    .where(and(liveCallsFilter(projectId, since), IS_ERROR))
    .groupBy(sql`coalesce(${runtimeAiCalls.errorKind}, 'unknown')`)
    .orderBy(desc(sql`count(*)`))
    .limit(AI_ERROR_KINDS.length);

  return rows.map((r) => ({ errorKind: r.errorKind, calls: Number(r.calls) }));
}

/**
 * The project's own normal hourly spend, as a median over hours that actually
 * had traffic.
 *
 * A flat threshold cannot recognise a runaway loop. A project that normally
 * spends five cents an hour and suddenly spends three dollars is sixty times
 * over its own baseline and nowhere near a $10 ceiling; a project that
 * normally spends fifty dollars an hour would page someone every hour. The
 * median is taken over non-empty hours so that a service used a few hours a
 * day is not compared against its own idle time, and it ignores the current
 * hour, which is the one under suspicion.
 */
export async function getSpendBaselineMicroUsd(
  projectId: string,
  days = 7,
  now: Date = new Date(),
): Promise<number | null> {
  const currentHour = new Date(now);
  currentHour.setUTCMinutes(0, 0, 0);
  const since = new Date(currentHour.getTime() - days * 24 * 3600_000);

  const [row] = await db
    .select({
      median: sql<number | null>`percentile_cont(0.5) within group (order by hourly.total)`,
      hours: sql<number>`count(*)::int`,
    })
    .from(
      db
        .select({
          bucket: sql`date_trunc('hour', ${runtimeAiCalls.createdAt})`.as('bucket'),
          total: sql<number>`sum(${runtimeAiCalls.costMicroUsd})`.as('total'),
        })
        .from(runtimeAiCalls)
        .where(
          and(
            eq(runtimeAiCalls.projectId, projectId),
            gte(runtimeAiCalls.createdAt, since),
            sql`${runtimeAiCalls.createdAt} < ${currentHour}`,
            or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
          ),
        )
        .groupBy(sql`date_trunc('hour', ${runtimeAiCalls.createdAt})`)
        .having(sql`sum(${runtimeAiCalls.costMicroUsd}) > 0`)
        .as('hourly'),
    );

  // Too few active hours is not a baseline; saying so beats inventing one.
  if (!row || Number(row.hours ?? 0) < MIN_BASELINE_HOURS) return null;
  const median = row.median === null || row.median === undefined ? null : Number(row.median);
  return median !== null && Number.isFinite(median) && median > 0 ? Math.round(median) : null;
}

/** Below this many hours of real traffic, a project has no established normal. */
export const MIN_BASELINE_HOURS = 6;

export async function getSpendCeilingMicroUsd(projectId: string): Promise<number | null> {
  const [row] = await db
    .select({ c: projects.runtimeSpendCeilingMicroUsd })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.c != null ? Number(row.c) : null;
}

export async function setSpendCeiling(projectId: string, ceilingMicroUsd: number | null): Promise<void> {
  const value = ceilingMicroUsd !== null ? Math.max(0, Math.round(ceilingMicroUsd)) : null;
  await db.update(projects).set({ runtimeSpendCeilingMicroUsd: value }).where(eq(projects.id, projectId));
}

/** Insert-or-nothing — row mili = pehla alert is hour; nahi mili = dedupe. Race-safe. */
export async function claimSpendAlertHour(
  projectId: string,
  hour: Date,
  spentMicroUsd: number,
  projectedMicroUsd: number,
) {
  const [row] = await db
    .insert(runtimeSpendAlerts)
    .values({
      projectId,
      hour,
      spentMicroUsd: Math.max(0, Math.round(spentMicroUsd)),
      projectedMicroUsd: Math.max(0, Math.round(projectedMicroUsd)),
    })
    .onConflictDoNothing()
    .returning({ id: runtimeSpendAlerts.id });
  return row ?? null;
}

/**
 * Projects worth checking on this pass — those that actually spent something
 * recently.
 *
 * This used to select every project in the database, and the five-minute cron
 * then ran three queries per project in its own Inngest step. A fleet with a
 * thousand projects, nearly all of which have never made an AI call, produced
 * three thousand queries and a thousand steps every five minutes to discover
 * that nothing had happened. The window is deliberately wider than the cron
 * interval so a project is not dropped between runs.
 */
export async function listSpendWatchProjectIds(windowMinutes = 30): Promise<string[]> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const rows = await db
    .selectDistinct({ id: runtimeAiCalls.projectId })
    .from(runtimeAiCalls)
    .where(
      and(
        gte(runtimeAiCalls.createdAt, since),
        or(isNull(runtimeAiCalls.source), ne(runtimeAiCalls.source, 'sample')),
        sql`${runtimeAiCalls.costMicroUsd} > 0`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Deletes runtime_ai_calls older than cutoff in batches of batchSize (default 10,000)
 * in a loop to avoid holding long database table locks.
 */
export async function purgeOldAiCallsBatch(
  cutoff: Date,
  batchSize = 10_000,
): Promise<number> {
  let totalDeleted = 0;
  for (;;) {
    const deleted = await db.execute<{ id: string }>(sql`
      DELETE FROM ${runtimeAiCalls}
      WHERE id IN (
        SELECT id FROM ${runtimeAiCalls}
        WHERE ${runtimeAiCalls.createdAt} < ${cutoff}
        LIMIT ${batchSize}
      )
      RETURNING id
    `);

    const count =
      (deleted as { rowCount?: number })?.rowCount ??
      (Array.isArray(deleted)
        ? deleted.length
        : Array.isArray((deleted as { rows?: unknown[] })?.rows)
          ? (deleted as { rows: unknown[] }).rows.length
          : 0);
    totalDeleted += count;
    if (count < batchSize) break;
  }
  return totalDeleted;
}

/**
 * Fetches the cached LiteLLM pricing catalog from PostgreSQL.
 * Returns array of CatalogEntry or null if not yet synced.
 */
export async function getModelPricingCatalog(): Promise<CatalogEntry[] | null> {
  const [row] = await db
    .select({ catalog: runtimeModelPricing.catalog })
    .from(runtimeModelPricing)
    .where(eq(runtimeModelPricing.id, 'litellm'))
    .limit(1);
  return (row?.catalog as CatalogEntry[]) ?? null;
}

/**
 * Upserts the LiteLLM pricing catalog row (id: 'litellm').
 */
export async function upsertModelPricingCatalog(
  catalog: CatalogEntry[],
  fetchedAt: Date = new Date(),
): Promise<void> {
  await db
    .insert(runtimeModelPricing)
    .values({
      id: 'litellm',
      catalog,
      entryCount: catalog.length,
      fetchedAt,
    })
    .onConflictDoUpdate({
      target: runtimeModelPricing.id,
      set: {
        catalog,
        entryCount: catalog.length,
        fetchedAt,
      },
    });
}
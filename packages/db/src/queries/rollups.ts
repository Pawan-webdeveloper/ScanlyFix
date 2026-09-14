/**
 * Rollup queries for monitor events.
 *
 * Aggregates raw events into hourly and daily rollups for fast queries.
 * Used by the rollup-worker Inngest function.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  monitorEvents,
  monitorHourlyRollups,
  monitorDailyRollups,
  monitors,
} from '../schema.ts'

/**
 * Aggregates raw events for a specific hour into the hourly rollup table.
 *
 * Uses UPSERT (INSERT ... ON CONFLICT) for idempotency — re-running the
 * aggregation for the same hour will update, not duplicate.
 *
 * @param hour - The hour to aggregate (truncated to hour boundary)
 * @returns Number of monitors processed
 */
export async function aggregateHourlyRollup(hour: Date): Promise<{ monitorsProcessed: number }> {
  // Truncate to hour boundary
  const hourTruncated = new Date(hour)
  hourTruncated.setMinutes(0, 0, 0)

  const nextHour = new Date(hourTruncated)
  nextHour.setHours(nextHour.getHours() + 1)

  // Aggregate raw events for this hour
  const aggregated = await db.execute<{
    monitor_id: string
    total_checks: number
    up_checks: number
    avg_latency_ms: number | null
    p95_latency_ms: number | null
    min_latency_ms: number | null
    max_latency_ms: number | null
  }>(sql`
    INSERT INTO monitor_hourly_rollups (
      monitor_id, hour, total_checks, up_checks,
      avg_latency_ms, p95_latency_ms, min_latency_ms, max_latency_ms
    )
    SELECT
      monitor_id,
      ${hourTruncated} AS hour,
      COUNT(*)::int AS total_checks,
      COUNT(*) FILTER (WHERE ok)::int AS up_checks,
      AVG(latency_ms)::int AS avg_latency_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95_latency_ms,
      MIN(latency_ms) AS min_latency_ms,
      MAX(latency_ms) AS max_latency_ms
    FROM monitor_events
    WHERE ts >= ${hourTruncated}
      AND ts < ${nextHour}
    GROUP BY monitor_id
    ON CONFLICT (monitor_id, hour)
    DO UPDATE SET
      total_checks = EXCLUDED.total_checks,
      up_checks = EXCLUDED.up_checks,
      avg_latency_ms = EXCLUDED.avg_latency_ms,
      p95_latency_ms = EXCLUDED.p95_latency_ms,
      min_latency_ms = EXCLUDED.min_latency_ms,
      max_latency_ms = EXCLUDED.max_latency_ms
    RETURNING monitor_id
  `)

  return { monitorsProcessed: aggregated.rowCount ?? 0 }
}

/**
 * Aggregates raw events for a specific day into the daily rollup table.
 *
 * @param day - The day to aggregate (truncated to day boundary)
 * @returns Number of monitors processed
 */
export async function aggregateDailyRollup(day: Date): Promise<{ monitorsProcessed: number }> {
  // Truncate to day boundary
  const dayTruncated = new Date(day)
  dayTruncated.setHours(0, 0, 0, 0)

  const nextDay = new Date(dayTruncated)
  nextDay.setDate(nextDay.getDate() + 1)

  // Aggregate raw events for this day
  const aggregated = await db.execute<{
    monitor_id: string
    total_checks: number
    up_checks: number
    avg_latency_ms: number | null
    p95_latency_ms: number | null
  }>(sql`
    INSERT INTO monitor_daily_rollups (
      monitor_id, day, total_checks, up_checks,
      avg_latency_ms, p95_latency_ms
    )
    SELECT
      monitor_id,
      ${dayTruncated} AS day,
      COUNT(*)::int AS total_checks,
      COUNT(*) FILTER (WHERE ok)::int AS up_checks,
      AVG(latency_ms)::int AS avg_latency_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95_latency_ms
    FROM monitor_events
    WHERE ts >= ${dayTruncated}
      AND ts < ${nextDay}
    GROUP BY monitor_id
    ON CONFLICT (monitor_id, day)
    DO UPDATE SET
      total_checks = EXCLUDED.total_checks,
      up_checks = EXCLUDED.up_checks,
      avg_latency_ms = EXCLUDED.avg_latency_ms,
      p95_latency_ms = EXCLUDED.p95_latency_ms
    RETURNING monitor_id
  `)

  return { monitorsProcessed: aggregated.rowCount ?? 0 }
}

/**
 * Deletes old raw events in batches.
 *
 * Uses batch delete of 1000 rows to avoid long-running transactions
 * and table locks. Called by the rollup-worker in a loop until no
 * more old events remain.
 *
 * @param batchSize - Number of rows to delete per batch (default 1000)
 * @returns Number of rows deleted in this batch
 */
export async function cleanupOldEvents(batchSize = 1000): Promise<number> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 90)

  const deleted = await db.execute<{ id: string }>(sql`
    DELETE FROM monitor_events
    WHERE id IN (
      SELECT id FROM monitor_events
      WHERE ts < ${cutoff}
      LIMIT ${batchSize}
    )
    RETURNING id
  `)

  return deleted.rowCount ?? 0
}

/**
 * Uptime result type with latency stats.
 * uptimePercent is null when no events exist (zero-event monitors).
 */
export type UptimeResultWithLatency = {
  total: number
  up: number
  down: number
  uptimePercent: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
}

/**
 * Response time data point for charts.
 */
export type ResponseTimePoint = {
  timestamp: Date
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  maxLatencyMs: number | null
  totalChecks: number
}

/**
 * Gets response time data from hourly rollups.
 *
 * @param monitorId - The monitor to query
 * @param start - Start of time range
 * @param end - End of time range
 * @returns Array of hourly response time data points
 */
export async function getResponseTimesFromHourlyRollups(
  monitorId: string,
  start: Date,
  end: Date,
): Promise<ResponseTimePoint[]> {
  const rows = await db
    .select({
      hour: monitorHourlyRollups.hour,
      avgLatencyMs: monitorHourlyRollups.avgLatencyMs,
      p95LatencyMs: monitorHourlyRollups.p95LatencyMs,
      maxLatencyMs: monitorHourlyRollups.maxLatencyMs,
      totalChecks: monitorHourlyRollups.totalChecks,
    })
    .from(monitorHourlyRollups)
    .where(
      and(
        eq(monitorHourlyRollups.monitorId, monitorId),
        gte(monitorHourlyRollups.hour, start),
        lte(monitorHourlyRollups.hour, end),
      ),
    )
    .orderBy(monitorHourlyRollups.hour)

  return rows.map((row) => ({
    timestamp: row.hour,
    avgLatencyMs: row.avgLatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    maxLatencyMs: row.maxLatencyMs,
    totalChecks: row.totalChecks,
  }))
}

/**
 * Gets response time data from daily rollups.
 *
 * @param monitorId - The monitor to query
 * @param start - Start of time range
 * @param end - End of time range
 * @returns Array of daily response time data points
 */
export async function getResponseTimesFromDailyRollups(
  monitorId: string,
  start: Date,
  end: Date,
): Promise<ResponseTimePoint[]> {
  const rows = await db
    .select({
      day: monitorDailyRollups.day,
      avgLatencyMs: monitorDailyRollups.avgLatencyMs,
      p95LatencyMs: monitorDailyRollups.p95LatencyMs,
      totalChecks: monitorDailyRollups.totalChecks,
    })
    .from(monitorDailyRollups)
    .where(
      and(
        eq(monitorDailyRollups.monitorId, monitorId),
        gte(monitorDailyRollups.day, start),
        lte(monitorDailyRollups.day, end),
      ),
    )
    .orderBy(monitorDailyRollups.day)

  return rows.map((row) => ({
    timestamp: row.day,
    avgLatencyMs: row.avgLatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    maxLatencyMs: row.p95LatencyMs, // No separate max in daily rollups, use p95 as proxy
    totalChecks: row.totalChecks,
  }))
}

/**
 * Gets uptime from hourly rollups for a time range.
 *
 * @param monitorId - The monitor to query
 * @param start - Start of time range
 * @param end - End of time range
 * @returns Uptime statistics with latency from rollups
 */

/* -------------------------------------------------------------------------- */
/* Rollups plus the part that has not been rolled up yet                       */
/* -------------------------------------------------------------------------- */

/**
 * Raw-event totals for the tail of a window.
 *
 * Rollups are written by a cron, so there is always a stretch of recent time
 * they do not cover yet. Reading only the rollup tables — which is what these
 * functions used to do — meant the numbers on the page lagged that cron:
 *
 *   - The daily rollup runs ONCE a day, at 05:05 (rollup-worker.ts:47). So the
 *     7-day and 30-day uptime figures contained nothing that happened today. A
 *     site that went down at 09:00 still showed the percentage it had
 *     yesterday, all day, on the page the customer opened BECAUSE it went down.
 *   - A monitor enabled this morning had no daily rollup at all, so `total` was
 *     0, `uptimePercent` was null, and the page showed a dash for a day. The
 *     customer's first experience of the feature was a number that never arrived.
 *   - The hourly rollup runs at :05 past the hour, so the 24-hour figure was
 *     missing up to an hour of the most recent — and most relevant — data.
 *
 * The fix is to read the raw events for whatever the rollups do not cover.
 * Events are retained for 90 days, which is the whole window any of these
 * periods ask for, so nothing is lost and nothing is estimated.
 */
async function rawTotals(
  monitorId: string,
  start: Date,
  end: Date,
): Promise<{ total: number; up: number; avgLatencyMs: number | null; maxLatencyMs: number | null }> {
  if (start >= end) return { total: 0, up: 0, avgLatencyMs: null, maxLatencyMs: null }

  const [row] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      up: sql<number>`COUNT(*) FILTER (WHERE ${monitorEvents.ok})::int`,
      avgLatencyMs: sql<number | null>`ROUND(AVG(${monitorEvents.latencyMs}))`,
      maxLatencyMs: sql<number | null>`MAX(${monitorEvents.latencyMs})`,
    })
    .from(monitorEvents)
    .where(
      and(
        eq(monitorEvents.monitorId, monitorId),
        gte(monitorEvents.ts, start),
        lte(monitorEvents.ts, end),
      ),
    )

  return {
    total: row?.total ?? 0,
    up: row?.up ?? 0,
    avgLatencyMs: row?.avgLatencyMs ?? null,
    maxLatencyMs: row?.maxLatencyMs ?? null,
  }
}

/**
 * Combines a rollup total with a raw-event total.
 *
 * The averages are weighted by check count rather than averaged, because
 * averaging two averages over different sample sizes is simply the wrong
 * number. p95 cannot be recovered from a rollup plus raw rows, so the larger of
 * the two is reported — an over-estimate is the safe direction for a latency
 * figure someone is using to decide whether their site feels slow.
 */
export function combine(
  rollup: { total: number; up: number; avgLatencyMs: number | null; p95LatencyMs: number | null },
  raw: { total: number; up: number; avgLatencyMs: number | null; maxLatencyMs: number | null },
): UptimeResultWithLatency {
  const total = rollup.total + raw.total
  const up = rollup.up + raw.up

  const weighted =
    total === 0
      ? null
      : Math.round(
          ((rollup.avgLatencyMs ?? 0) * rollup.total + (raw.avgLatencyMs ?? 0) * raw.total) / total,
        )

  const p95Candidates = [rollup.p95LatencyMs, raw.maxLatencyMs].filter(
    (v): v is number => typeof v === 'number',
  )

  return {
    total,
    up,
    down: total - up,
    uptimePercent: total === 0 ? null : Math.round((up / total) * 10_000) / 100,
    avgLatencyMs: total === 0 ? null : weighted,
    p95LatencyMs: p95Candidates.length > 0 ? Math.max(...p95Candidates) : null,
  }
}

/**
 * Where the raw tail begins.
 *
 * Exported for tests: the boundary is the whole correctness argument. One
 * bucket too early double-counts every check in it, one too late drops them.
 */
export function tailStartAfter(covered: Date | null, bucketMs: number, windowStart: Date): Date {
  if (!covered) return windowStart
  const next = new Date(covered.getTime() + bucketMs)
  return next > windowStart ? next : windowStart
}

/** Newest rollup boundary already covered, so the raw tail starts after it. */
async function lastCoveredAt(
  table: typeof monitorHourlyRollups | typeof monitorDailyRollups,
  column: typeof monitorHourlyRollups.hour | typeof monitorDailyRollups.day,
  monitorId: string,
  start: Date,
  end: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`MAX(${column})` })
    .from(table)
    .where(and(eq(table.monitorId, monitorId), gte(column, start), lte(column, end)))
  return row?.at ? new Date(row.at) : null
}

export async function getUptimeFromHourlyRollups(
  monitorId: string,
  start: Date,
  end: Date,
): Promise<UptimeResultWithLatency> {
  const [result] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${monitorHourlyRollups.totalChecks}), 0)::int`,
      up: sql<number>`COALESCE(SUM(${monitorHourlyRollups.upChecks}), 0)::int`,
      avgLatencyMs: sql<number | null>`ROUND(SUM(${monitorHourlyRollups.avgLatencyMs} * ${monitorHourlyRollups.totalChecks}) / NULLIF(SUM(${monitorHourlyRollups.totalChecks}), 0))`,
      p95LatencyMs: sql<number | null>`MAX(${monitorHourlyRollups.p95LatencyMs})`,
    })
    .from(monitorHourlyRollups)
    .where(
      and(
        eq(monitorHourlyRollups.monitorId, monitorId),
        gte(monitorHourlyRollups.hour, start),
        lte(monitorHourlyRollups.hour, end),
      ),
    )

  // The hourly cron runs at :05, so the newest complete hour is the newest
  // rollup row. Everything after it is read from the raw events — the boundary
  // comes from the data rather than the clock, so a late or skipped cron run
  // widens the raw window instead of losing the checks inside it.
  const covered = await lastCoveredAt(monitorHourlyRollups, monitorHourlyRollups.hour, monitorId, start, end)
  const raw = await rawTotals(monitorId, tailStartAfter(covered, 3_600_000, start), end)

  return combine(
    {
      total: result?.total ?? 0,
      up: result?.up ?? 0,
      avgLatencyMs: result?.avgLatencyMs ?? null,
      p95LatencyMs: result?.p95LatencyMs ?? null,
    },
    raw,
  )
}

/**
 * Gets uptime from daily rollups for a time range.
 *
 * @param monitorId - The monitor to query
 * @param start - Start of time range
 * @param end - End of time range
 * @returns Uptime statistics with latency from rollups
 */
export async function getUptimeFromDailyRollups(
  monitorId: string,
  start: Date,
  end: Date,
): Promise<UptimeResultWithLatency> {
  const [result] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${monitorDailyRollups.totalChecks}), 0)::int`,
      up: sql<number>`COALESCE(SUM(${monitorDailyRollups.upChecks}), 0)::int`,
      avgLatencyMs: sql<number | null>`ROUND(SUM(${monitorDailyRollups.avgLatencyMs} * ${monitorDailyRollups.totalChecks}) / NULLIF(SUM(${monitorDailyRollups.totalChecks}), 0))`,
      p95LatencyMs: sql<number | null>`MAX(${monitorDailyRollups.p95LatencyMs})`,
    })
    .from(monitorDailyRollups)
    .where(
      and(
        eq(monitorDailyRollups.monitorId, monitorId),
        gte(monitorDailyRollups.day, start),
        lte(monitorDailyRollups.day, end),
      ),
    )

  // The daily cron runs once, at 05:05, so today is never in these rows and
  // often yesterday is not either. Read whatever they do not cover from the raw
  // events rather than reporting a percentage that stops at the last cron run.
  const covered = await lastCoveredAt(monitorDailyRollups, monitorDailyRollups.day, monitorId, start, end)
  const raw = await rawTotals(monitorId, tailStartAfter(covered, 86_400_000, start), end)

  return combine(
    {
      total: result?.total ?? 0,
      up: result?.up ?? 0,
      avgLatencyMs: result?.avgLatencyMs ?? null,
      p95LatencyMs: result?.p95LatencyMs ?? null,
    },
    raw,
  )
}

/**
 * Gets daily buckets for the 90-day status page strip from daily rollups.
 *
 * @param monitorId - The monitor to query
 * @param days - Number of days to look back (default 90)
 * @returns Daily buckets with date and ok status
 */
export async function getDailyBucketsFromRollups(
  monitorId: string,
  days = 90,
): Promise<Array<{ date: string; ok: boolean; total: number }>> {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  cutoff.setHours(0, 0, 0, 0)

  const rows = await db
    .select({
      date: sql<string>`(${monitorDailyRollups.day} at time zone 'utc')::date::text`,
      total: sql<number>`SUM(${monitorDailyRollups.totalChecks})::int`,
      up: sql<number>`SUM(${monitorDailyRollups.upChecks})::int`,
    })
    .from(monitorDailyRollups)
    .where(
      and(
        eq(monitorDailyRollups.monitorId, monitorId),
        gte(monitorDailyRollups.day, cutoff),
      ),
    )
    .groupBy(sql`(${monitorDailyRollups.day} at time zone 'utc')::date`)
    .orderBy(sql`(${monitorDailyRollups.day} at time zone 'utc')::date`)

  return rows.map((row) => ({
    date: row.date,
    ok: row.up === row.total,
    total: row.total,
  }))
}

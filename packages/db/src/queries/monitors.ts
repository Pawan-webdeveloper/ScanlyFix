/**
 * Monitors and the events they produce.
 *
 * Same Viewer rule as everywhere else, with ONE deliberate exception:
 * `dueMonitorsForScheduler` takes no Viewer and returns rows across every
 * account. It has to — it runs from a cron with nobody signed in, and its whole
 * job is "what is due, anywhere". The name says so rather than hiding it behind
 * a neutral one, because an unfiltered query that reads like a normal one is
 * how the exception becomes the rule.
 */

import { and, asc, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm' /* uptime error — was missing gte, caused ReferenceError at runtime in getUptime() */
import { db } from '../client.ts'
import {
  incidents,
  monitorEvents,
  monitors,
  projects,
  scans,
  dnsSnapshots,
  snoozedMonitors,
  users,
  webVitalsSnapshots,
  type Incident,
  type Monitor,
  type MonitorEvent,
  type SnoozedMonitor,
} from '../schema.ts' /* monitor error — added missing Incident type import */
import { getProject } from './projects.ts'
import { listIncidentUpdatesPublicForIncidents } from './incident-updates.ts'
import type { Viewer } from './viewer.ts'
// ─── DNS Snapshot Queries ─────────────────────────────────────────────────────

import type { DnsRecord } from '../dns-checker.ts'
import { DnsRecordsSchema } from '../dns-checker.ts'

import type { MonitorEventDiff, MonitorLogEntry } from '../types/monitor-diff.ts'
import { MonitorEventDiffSchema } from '../types/monitor-diff.ts'




export type MonitorType = Monitor['type']

/**
 * Computes the display status for a monitor, including stale detection.
 *
 * A monitor is considered "stale" when the time since its last run exceeds
 * 3× its configured interval. This indicates the worker may be dead or
 * stuck, and the monitor's lastStatus is no longer reliable.
 *
 * Status priority: disabled > stale > down > up > null (never run).
 *
 * ## Why "disabled" is its own status, not "stale"
 *
 * A disabled monitor has `lastStatus` frozen at whatever it was the moment the
 * user paused it — frequently `down`, because pausing is what you do when a
 * site is down. If we surfaced that frozen value as the live status, the
 * user would reopen the Uptime page, see a red "down" indicator on the
 * monitor they paused, and conclude the probe was still running. The monitor
 * is *not* down, up, or stale — it is paused. Treating it as anything else
 * is a UI lie.
 */
export function getMonitorStatus(
  lastRunAt: Date | null,
  lastStatus: 'up' | 'down' | null,
  intervalS: number,
  enabled: boolean = true,
): { status: 'up' | 'down' | 'stale' | 'disabled' | null; isStale: boolean; label: string } {
  // Disabled first — short-circuits everything else so a paused monitor
  // never reads as "down" because of its frozen lastStatus.
  if (!enabled) {
    return { status: 'disabled', isStale: false, label: 'Paused' }
  }

  // Never run — show as unknown
  if (!lastRunAt) {
    return { status: null, isStale: false, label: 'No recent checks' }
  }

  const now = Date.now()
  const staleThresholdMs = intervalS * 1000 * 3
  const timeSinceLastRun = now - lastRunAt.getTime()

  // Stale check: 3× interval without a run
  if (timeSinceLastRun > staleThresholdMs) {
    return { status: 'stale', isStale: true, label: 'No recent checks' }
  }

  // Fresh — return actual status
  return {
    status: lastStatus,
    isStale: false,
    label: lastStatus === 'up' ? 'Operational' : lastStatus === 'down' ? 'Down' : 'Unknown',
  }
}

export async function listMonitors(projectId: string, viewer: Viewer): Promise<Monitor[]> {
  if (!(await getProject(projectId, viewer))) return []
  return db.query.monitors.findMany({ where: eq(monitors.projectId, projectId), orderBy: asc(monitors.type) })
}

/**
 * One monitor per (project, type) — the schema enforces it with a unique index,
 * so this upserts rather than risking a second row for the same job.
 */
export async function setMonitor(
  projectId: string,
  viewer: Viewer,
  input: { type: MonitorType; enabled: boolean; intervalS?: number },
): Promise<Monitor | null> {
  if (!(await getProject(projectId, viewer))) return null

  const [row] = await db
    .insert(monitors)
    .values({
      projectId,
      type: input.type,
      enabled: input.enabled,
      ...(input.intervalS === undefined ? {} : { intervalS: input.intervalS }),
    })
    .onConflictDoUpdate({
      target: [monitors.projectId, monitors.type],
      set: {
        enabled: input.enabled,
        ...(input.intervalS === undefined ? {} : { intervalS: input.intervalS }),
      },
    })
    .returning()

  return row ?? null
}

export interface DueMonitor {
  id: string
  type: MonitorType
  projectId: string
  projectUrl: string
  projectSlug: string
  /** Who the alert belongs to. Carried here so a job needs no second lookup. */
  ownerId: string
}

/**
 * SYSTEM QUERY — no Viewer, every account. See the file header.
 *
 * Atomic claim: fetches due monitors AND advances their lastRunAt in a single
 * UPDATE RETURNING. This prevents race conditions when multiple sweep
 * invocations run concurrently — each monitor is claimed by exactly one sweep.
 *
 * Due means enabled and never run, or enabled and last run longer ago than its
 * own interval. Computed in SQL rather than by fetching everything and
 * filtering in Node: at a thousand monitors the difference is a scan of the
 * index versus a scan of the table, every minute, forever.
 *
 * The UPDATE sets lastRunAt = now() for all claimed monitors, which:
 *   1. Atomically claims them (no two sweeps can claim the same monitor)
 *   2. Advances the lease so the next sweep won't re-dispatch them
 *   3. If the probe fails, the monitor will be retried after its normal interval
 */
export async function claimDueMonitors(limit = 500): Promise<DueMonitor[]> {
  // Atomic claim: UPDATE ... RETURNING in a single statement
  // This is the optimistic lease pattern — claim + fetch in one step
  const claimed = await db.execute<{
    id: string
    type: string
    projectId: string
    projectUrl: string
    projectSlug: string
    ownerId: string
  }>(sql`
    UPDATE monitors
    SET last_run_at = now()
    WHERE id IN (
      SELECT m.id
      FROM monitors m
      INNER JOIN projects p ON p.id = m.project_id
      WHERE m.enabled = true
        AND (
          m.last_run_at IS NULL
          OR m.last_run_at < now() - make_interval(secs => m.interval_s)
        )
      ORDER BY coalesce(m.last_run_at, 'epoch'::timestamptz)
      LIMIT ${limit}
    )
    RETURNING
      id,
      type,
      project_id AS "projectId",
      (SELECT url FROM projects WHERE id = project_id) AS "projectUrl",
      (SELECT slug FROM projects WHERE id = project_id) AS "projectSlug",
      (SELECT owner_id FROM projects WHERE id = project_id) AS "ownerId"
  `)

  // Convert snake_case columns to camelCase for the DueMonitor interface
  return claimed.rows.map((row) => ({
    id: row.id,
    type: row.type as MonitorType,
    projectId: row.projectId,
    projectUrl: row.projectUrl,
    projectSlug: row.projectSlug,
    ownerId: row.ownerId,
  }))
}

/**
 * @deprecated Use claimDueMonitors() instead — it atomically claims monitors
 * to prevent double-dispatch in concurrent sweeps.
 */
export async function dueMonitorsForScheduler(limit = 500): Promise<DueMonitor[]> {
  return db
    .select({
      id: monitors.id,
      type: monitors.type,
      projectId: monitors.projectId,
      projectUrl: projects.url,
      projectSlug: projects.slug,
      ownerId: projects.ownerId,
    })
    .from(monitors)
    .innerJoin(projects, eq(projects.id, monitors.projectId))
    .where(
      and(
        eq(monitors.enabled, true),
        or(
          isNull(monitors.lastRunAt),
          lte(monitors.lastRunAt, sql`now() - make_interval(secs => ${monitors.intervalS})`),
        ),
      ),
    )
    // Longest-waiting first, so a backlog drains fairly instead of starving
    // whichever monitor happens to sort last.
    .orderBy(asc(sql`coalesce(${monitors.lastRunAt}, 'epoch'::timestamptz)`))
    .limit(limit)
}

export interface MonitorOutcome {
  ok: boolean
  statusCode?: number | null
  latencyMs?: number | null
  detail?: string | null
}

/**
 * Records what happened and marks the monitor run, in one transaction — a
 * monitor whose lastRunAt advanced without an event would silently skip its
 * next turn, and one with an event but no lastRunAt would run again immediately.
 */
export async function recordMonitorRun(monitorId: string, outcome: MonitorOutcome): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(monitorEvents).values({
      monitorId,
      ok: outcome.ok,
      statusCode: outcome.statusCode ?? null,
      latencyMs: outcome.latencyMs ?? null,
      detail: outcome.detail ?? null,
    })
    await tx
      .update(monitors)
      .set({ lastRunAt: new Date(), lastStatus: outcome.ok ? 'up' : 'down' }) /* uptime error — use 'up'/'down' to match monitorTypeEnum semantics and UI checks */
      .where(eq(monitors.id, monitorId))
  })
}

export async function recentEvents(monitorId: string, viewer: Viewer, limit = 90): Promise<MonitorEvent[]> {
  if (viewer.kind !== 'user') return []

  // Same ownership-in-join pattern as listIncidents — see the comment there
  // for why we don't go through getProject() first. Halves the round-trips
  // (and pool sockets held) for the timeline view the moment the page loads.
  const rows = await db
    .select({ event: monitorEvents })
    .from(monitorEvents)
    .innerJoin(monitors, eq(monitors.id, monitorEvents.monitorId))
    .innerJoin(projects, eq(projects.id, monitors.projectId))
    .where(and(eq(monitorEvents.monitorId, monitorId), eq(projects.ownerId, viewer.userId)))
    .orderBy(desc(monitorEvents.ts))
    .limit(limit)

  return rows.map((r) => r.event)
}

/**
 * How many runs in a row have failed, newest first.
 *
 * The alerting rule is built on this: one failure is noise — a timeout, a
 * deploy, a blip — and a monitoring product that emails about it teaches people
 * to filter it. Two in a row is a site that is actually down.
 */
export async function consecutiveFailures(monitorId: string, look = 10): Promise<number> {
  const events = await db.query.monitorEvents.findMany({
    where: eq(monitorEvents.monitorId, monitorId),
    orderBy: desc(monitorEvents.ts),
    limit: look,
    columns: { ok: true },
  })

  let streak = 0
  for (const event of events) {
    if (event.ok) break
    streak += 1
  }
  return streak
}

/**
 * SYSTEM QUERY — no Viewer. A monitor job comparing this run to the last one is
 * reading scans it just caused, for a project the scheduler already resolved.
 * Threading a synthetic viewer through would look like authorization while
 * proving nothing; naming it for what it is keeps the exception visible.
 */
export async function recentScansForScheduler(projectId: string, limit = 2) {
  return db.query.scans.findMany({
    where: eq(scans.projectId, projectId),
    orderBy: desc(scans.createdAt),
    limit,
  })
}

/**
 * Opens a new incident for a monitor.
 *
 * Called only when recordAlertOnce returns a fresh alert — so if the alert
 * deduplicates, the incident does too. One alert, one incident, always in sync.
 */
export async function createIncident(
  monitorId: string,
  meta: { statusCode?: number | null; detail?: string | null },
): Promise<{ id: string; startedAt: Date }> {
  const now = new Date()
  const [row] = await db
    .insert(incidents)
    .values({
      monitorId,
      startedAt: now,
      statusCode: meta.statusCode ?? null,
      detail: meta.detail ?? null,
    })
    .returning({ id: incidents.id })

  if (!row) throw new Error('createIncident: insert returned no row')
  return { id: row.id, startedAt: now }
}

/**
 * Resolves ALL open incidents for a monitor.
 *
 * Called as soon as a probe comes back ok — recovery is immediate, no streak
 * needed. If no open incident exists this is a no-op, so it is safe to call
 * on every successful check.
 *
 * Resolves all open incidents (not just the most recent) to prevent stale
 * open incidents from accumulating due to race conditions at day boundaries.
 *
 * Returns the resolved incidents with duration info for recovery alerts.
 */
export async function resolveIncident(monitorId: string): Promise<Array<{
  id: string
  startedAt: Date
  durationMs: number
  statusCode: number | null
  detail: string | null
}>> {
  const openIncidents = await db.query.incidents.findMany({
    where: and(
      eq(incidents.monitorId, monitorId),
      isNull(incidents.resolvedAt),
    ),
    orderBy: desc(incidents.startedAt),
  })

  if (openIncidents.length === 0) return []

  const now = new Date()
  const resolved: Array<{
    id: string
    startedAt: Date
    durationMs: number
    statusCode: number | null
    detail: string | null
  }> = []

  // Resolve all open incidents (typically 0 or 1, but handle edge cases)
  for (const incident of openIncidents) {
    const durationMs = now.getTime() - incident.startedAt.getTime()
    await db
      .update(incidents)
      .set({ resolvedAt: now, durationMs })
      .where(eq(incidents.id, incident.id))

    resolved.push({
      id: incident.id,
      startedAt: incident.startedAt,
      durationMs,
      statusCode: incident.statusCode,
      detail: incident.detail,
    })
  }

  return resolved
}

/**
 * Returns the most recent open incident for a monitor, or null if none.
 *
 * Used by uptime-probe to:
 *   - Detect if we're in a downtime state (for reminder logic)
 *   - Get incident start time for reminder slot calculation
 */
export async function getOpenIncident(monitorId: string): Promise<{
  id: string
  startedAt: Date
  statusCode: number | null
  detail: string | null
} | null> {
  const incident = await db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      isNull(incidents.resolvedAt),
    ),
    orderBy: desc(incidents.startedAt),
    columns: {
      id: true,
      startedAt: true,
      statusCode: true,
      detail: true,
    },
  })

  return incident ?? null
}




/* -------------------------------------------------------------------------- */
/* Phase 5 — Dashboard queries                                                 */
/* -------------------------------------------------------------------------- */

 
/**
 * Latest event row per monitor, used to surface the live HTTP status code in
 * the dashboard without an extra round-trip per row. Pulled in via a lateral
 * subquery so the outer scan stays a simple join.
 */
const LATEST_STATUS_CODE_SUBQUERY = sql<number | null>`
  (
    SELECT ${monitorEvents.statusCode}
    FROM ${monitorEvents}
    WHERE ${monitorEvents.monitorId} = ${monitors.id}
    ORDER BY ${monitorEvents.ts} DESC
    LIMIT 1
  )
`

const LATEST_LATENCY_MS_SUBQUERY = sql<number | null>`
  (
    SELECT ${monitorEvents.latencyMs}
    FROM ${monitorEvents}
    WHERE ${monitorEvents.monitorId} = ${monitors.id}
    ORDER BY ${monitorEvents.ts} DESC
    LIMIT 1
  )
`

const LATEST_DETAIL_SUBQUERY = sql<string | null>`
  (
    SELECT ${monitorEvents.detail}
    FROM ${monitorEvents}
    WHERE ${monitorEvents.monitorId} = ${monitors.id}
    ORDER BY ${monitorEvents.ts} DESC
    LIMIT 1
  )
`

/**
 * All monitors across every project owned by the viewer.
 * Used on the main dashboard to show a single unified list.
 *
 * Includes computed `isStale` field based on lastRunAt vs intervalS, plus the
 * latest event's `statusCode`, `latencyMs`, and `detail` so the UI can show
 * the live HTTP code (e.g. 200, 503, 404) without waiting for the next poll.
 */
export async function listMonitorsForUser(
  viewer: Viewer,
): Promise<
  Array<
    Monitor & {
      projectUrl: string
      projectName: string
      isStale: boolean
      lastStatusCode: number | null
      lastLatencyMs: number | null
      lastDetail: string | null
    }
  >
> {
  /* monitor error — Viewer is a union type; userId only exists on kind: 'user'.
   * Must check kind before accessing userId to satisfy TypeScript. */
  if (viewer.kind !== 'user') return []

  const rows = await db
    .select({
      id: monitors.id,
      type: monitors.type,
      projectId: monitors.projectId,
      enabled: monitors.enabled,
      intervalS: monitors.intervalS,
      lastRunAt: monitors.lastRunAt,
      lastStatus: monitors.lastStatus,
      alertConfig: monitors.alertConfig,
      createdAt: monitors.createdAt,
      projectUrl: projects.url,
      projectName: projects.name,
      lastStatusCode: LATEST_STATUS_CODE_SUBQUERY,
      lastLatencyMs: LATEST_LATENCY_MS_SUBQUERY,
      lastDetail: LATEST_DETAIL_SUBQUERY,
    })
    .from(monitors)
    .innerJoin(projects, eq(projects.id, monitors.projectId))
    .where(eq(projects.ownerId, viewer.userId))
    .orderBy(desc(monitors.createdAt))

  // Compute isStale for each monitor. `enabled` is threaded through so a
  // paused monitor reads as disabled, not as the frozen lastStatus from the
  // last probe before the pause — see getMonitorStatus for the full reason.
  return rows.map((row) => ({
    ...row,
    isStale: getMonitorStatus(
      row.lastRunAt,
      row.lastStatus as 'up' | 'down' | null,
      row.intervalS,
      row.enabled,
    ).isStale,
  }))
}




/**
 * Uptime result type with latency stats.
 * uptimePercent is null when no events exist (zero-event monitors).
 */
export type UptimeResult = {
  total: number
  up: number
  down: number
  uptimePercent: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
}

/**
 * Uptime percentage for a monitor over a given period.
 *
 * Uses rollup tables for fast queries:
 *   - 24h: hourly rollups
 *   - 7d/30d: daily rollups
 *
 * Returns null uptimePercent when no events exist — a monitor that has never
 * run should not show "100% uptime" as that is misleading.
 */
export async function getUptime(
  monitorId: string,
  viewer: Viewer,
  period: '24h' | '7d' | '30d',
): Promise<UptimeResult> {
  if (viewer.kind !== 'user') {
    return { total: 0, up: 0, down: 0, uptimePercent: null, avgLatencyMs: null, p95LatencyMs: null }
  }

  // Ownership check + monitor lookup in ONE round-trip. The previous shape
  // fetched the monitor row, then made a second call to verify the project
  // belonged to the viewer — every API request held two pool connections
  // back-to-back, which is what tipped the Supabase session-mode pooler over
  // its 15-client ceiling during a multi-tab dashboard reload.
  const owner = await db
    .select({ projectId: monitors.projectId })
    .from(monitors)
    .innerJoin(projects, eq(projects.id, monitors.projectId))
    .where(and(eq(monitors.id, monitorId), eq(projects.ownerId, viewer.userId)))
    .limit(1)

  if (owner.length === 0) {
    return { total: 0, up: 0, down: 0, uptimePercent: null, avgLatencyMs: null, p95LatencyMs: null }
  }

  const now = new Date()
  const start = new Date(now)

  switch (period) {
    case '24h':
      start.setHours(start.getHours() - 24)
      break
    case '7d':
      start.setDate(start.getDate() - 7)
      break
    case '30d':
      start.setDate(start.getDate() - 30)
      break
  }

  // Use rollups for fast queries
  // Import here to avoid circular dependency
  const { getUptimeFromHourlyRollups, getUptimeFromDailyRollups } = await import('./rollups.ts')

  if (period === '24h') {
    // Use hourly rollups for 24h
    return getUptimeFromHourlyRollups(monitorId, start, now)
  } else {
    // Use daily rollups for 7d/30d
    return getUptimeFromDailyRollups(monitorId, start, now)
  }
}
 
/**
 * Incident history for a monitor, newest first.
 * Auth-gated: viewer must own the monitor's project.
 *
 * Joins the acknowledger's email so the UI can show "Acknowledged by X at
 * time" without a second round-trip per row. The join uses a left side
 * (incidents.acknowledgedBy) so an unacknowledged incident still returns.
 */
export async function listIncidents(
  monitorId: string,
  viewer: Viewer,
  limit = 50,
): Promise<IncidentWithAcknowledger[]> {
  if (viewer.kind !== 'user') return []

  // The monitor ownership check happens in the same query as the incident
  // fetch — joining `projects` here makes the WHERE filter `ownerId = $viewer`
  // authoritative at the database level. If the viewer doesn't own the
  // monitor, the join returns zero rows and the incidents are skipped without
  // a separate `getProject(...)` round-trip. Same logic, half the connections.
  const rows = await db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt,
      durationMs: incidents.durationMs,
      statusCode: incidents.statusCode,
      detail: incidents.detail,
      acknowledgedAt: incidents.acknowledgedAt,
      acknowledgedBy: incidents.acknowledgedBy,
      notes: incidents.notes,
      acknowledgerEmail: users.email,
    })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .innerJoin(projects, eq(projects.id, monitors.projectId))
    .leftJoin(users, eq(users.id, incidents.acknowledgedBy))
    .where(and(eq(incidents.monitorId, monitorId), eq(projects.ownerId, viewer.userId)))
    .orderBy(desc(incidents.startedAt))
    .limit(limit)

  return rows.map((r) => ({
    id: r.id,
    monitorId: r.monitorId,
    startedAt: r.startedAt,
    resolvedAt: r.resolvedAt,
    durationMs: r.durationMs,
    statusCode: r.statusCode,
    detail: r.detail,
    acknowledgedAt: r.acknowledgedAt,
    acknowledgedBy: r.acknowledgedBy,
    notes: r.notes,
    // Null when the acknowledger was deleted (ON DELETE SET NULL), or when
    // the incident has never been acknowledged.
    acknowledgerEmail: r.acknowledgerEmail,
  }))
}

/**
 * Single incident by id, with the acknowledger's email. Same join as
 * listIncidents so the UI can render the row from one query.
 *
 * Returns null when the incident does not exist OR the viewer does not own
 * the project — both are 404-equivalent in the API.
 */
export interface IncidentWithAcknowledger extends Incident {
  acknowledgerEmail: string | null
}

export async function getIncident(
  incidentId: string,
  viewer: Viewer,
): Promise<IncidentWithAcknowledger | null> {
  const row = await db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      startedAt: incidents.startedAt,
      resolvedAt: incidents.resolvedAt,
      durationMs: incidents.durationMs,
      statusCode: incidents.statusCode,
      detail: incidents.detail,
      acknowledgedAt: incidents.acknowledgedAt,
      acknowledgedBy: incidents.acknowledgedBy,
      notes: incidents.notes,
      acknowledgerEmail: users.email,
      projectId: monitors.projectId,
    })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .leftJoin(users, eq(users.id, incidents.acknowledgedBy))
    .where(eq(incidents.id, incidentId))
    .limit(1)

  const r = row[0]
  if (!r) return null

  // Auth: viewer must own the project. The 404 is the same for "not found"
  // and "not yours" so a non-member cannot probe which incident ids exist.
  if (!(await getProject(r.projectId, viewer))) return null

  return {
    id: r.id,
    monitorId: r.monitorId,
    startedAt: r.startedAt,
    resolvedAt: r.resolvedAt,
    durationMs: r.durationMs,
    statusCode: r.statusCode,
    detail: r.detail,
    acknowledgedAt: r.acknowledgedAt,
    acknowledgedBy: r.acknowledgedBy,
    notes: r.notes,
    acknowledgerEmail: r.acknowledgerEmail,
  }
}

/**
 * Mark an incident as acknowledged. Idempotent — re-acking updates the
 * timestamp + user (so a hand-off is visible), does not error.
 *
 * Auth-gated: viewer must own the monitor's project.
 *
 * Returns the updated incident with its acknowledger's email, so the API
 * route can return the full row without a follow-up read.
 */
export async function acknowledgeIncident(
  incidentId: string,
  viewer: Viewer,
): Promise<IncidentWithAcknowledger | null> {
  if (viewer.kind !== 'user') return null

  // 1. Look up incident + its project in one query. Inner join on monitors
  //    so a dangling monitor row is reported as "not found", not as a
  //    successful update.
  const lookup = await db
    .select({
      monitorId: incidents.monitorId,
      projectId: monitors.projectId,
    })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .where(eq(incidents.id, incidentId))
    .limit(1)

  const found = lookup[0]
  if (!found) return null
  if (!(await getProject(found.projectId, viewer))) return null

  // 2. Set the pair atomically. acknowledgedBy is the user id so the
  //    schema's ON DELETE SET NULL does the right thing if the user is
  //    later removed.
  await db
    .update(incidents)
    .set({
      acknowledgedAt: new Date(),
      acknowledgedBy: viewer.userId,
    })
    .where(eq(incidents.id, incidentId))

  // 3. Re-read for the response — single round trip, no stale snapshot.
  return getIncident(incidentId, viewer)
}

/**
 * Update an incident's notes. Replaces the text wholesale — no edit history
 * for now, since the audit trail is "this snapshot, this person, this
 * timestamp" and the row already says who acknowledged it.
 *
 * Empty string is normalised to null so "cleared" and "never set" look the
 * same on the row.
 *
 * Auth-gated: viewer must own the monitor's project.
 */
export async function setIncidentNotes(
  incidentId: string,
  viewer: Viewer,
  notes: string | null,
): Promise<IncidentWithAcknowledger | null> {
  const lookup = await db
    .select({ projectId: monitors.projectId })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .where(eq(incidents.id, incidentId))
    .limit(1)

  const found = lookup[0]
  if (!found) return null
  if (!(await getProject(found.projectId, viewer))) return null

  await db
    .update(incidents)
    .set({ notes: notes && notes.length > 0 ? notes : null })
    .where(eq(incidents.id, incidentId))

  return getIncident(incidentId, viewer)
}

// ─── Stale-incident auto-cleanup (Phase 5) ─────────────────────────────────────

/** Detail written to the row when a stale incident is auto-resolved. */
export const STALE_INCIDENT_AUTO_RESOLVE_DETAIL =
  'Auto-resolved: monitor reporting healthy'

/** Default cutoff: an incident older than this is eligible for auto-resolve. */
export const STALE_INCIDENT_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Open incidents that should be auto-resolved by the daily cron.
 *
 * An incident is "stale" when:
 *   1. It is still open (resolvedAt IS NULL), AND
 *   2. It started at least `staleAfterMs` ago (default 24h), AND
 *   3. Its monitor is currently reporting healthy (lastStatus = 'up').
 *
 * The 24h grace period absorbs a real outage that the recovery probe has not
 * yet caught up with — we only auto-resolve when the data tells us the site
 * is up AND the incident has had a full day to be closed by a real recovery.
 *
 * Returns the rows that qualify, in oldest-first order. The query is
 * system-only (no Viewer) — the cron is the caller and the action is
 * "trust the monitor's own signal, close a row".
 */
export interface StaleIncidentRow {
  id: string
  monitorId: string
  startedAt: Date
}

export async function findStaleOpenIncidents(
  options: { staleAfterMs?: number; limit?: number } = {},
): Promise<StaleIncidentRow[]> {
  const cutoff = new Date(Date.now() - (options.staleAfterMs ?? STALE_INCIDENT_AGE_MS))
  const limit = options.limit ?? 500

  return db
    .select({
      id: incidents.id,
      monitorId: incidents.monitorId,
      startedAt: incidents.startedAt,
    })
    .from(incidents)
    .innerJoin(monitors, eq(monitors.id, incidents.monitorId))
    .where(
      and(
        isNull(incidents.resolvedAt),
        // Cap at rows old enough to qualify. The "monitor healthy" check
        // happens in the JOIN — lastStatus = 'up' is the monitor's own
        // most recent verdict, written by the probe.
        lte(incidents.startedAt, cutoff),
        eq(monitors.lastStatus, 'up'),
      ),
    )
    .orderBy(incidents.startedAt)
    .limit(limit)
}

/**
 * Auto-resolve one stale incident. SYSTEM QUERY — no Viewer.
 *
 * Sets resolvedAt = now, durationMs = elapsed, and stamps the detail with
 * the canonical "Auto-resolved" string so a human can tell at a glance why
 * a row they never touched is now closed.
 *
 * Returns true if the row was updated, false if it no longer qualified
 * (someone else resolved it between find and update — race against a
 * real recovery). The cron treats false as a no-op.
 */
export async function autoResolveStaleIncident(
  incidentId: string,
): Promise<boolean> {
  // The WHERE re-checks the eligibility predicates so a concurrent
  // resolveIncident() call cannot lose to us.
  const cutoff = new Date(Date.now() - STALE_INCIDENT_AGE_MS)
  const result = await db
    .update(incidents)
    .set({
      resolvedAt: sql`now()`,
      durationMs: sql`(extract(epoch from (now() - ${incidents.startedAt})) * 1000)::int`,
      detail: STALE_INCIDENT_AUTO_RESOLVE_DETAIL,
    })
    .where(
      and(
        eq(incidents.id, incidentId),
        isNull(incidents.resolvedAt),
        // startedAt still in the stale window — the row may have been
        // resolved OR the monitor may have gone down again since the
        // findStaleOpenIncidents scan. The isNull check guards the
        // former; the join in findStaleOpenIncidents handled the latter
        // at scan time, but the cron runs in steps and the world moves
        // between them.
        lte(incidents.startedAt, cutoff),
      ),
    )
    .returning({ id: incidents.id })

  return result.length > 0
}



/**
 * Returns SSL + domain expiry data for a project's domain monitor.
 * Used by the Monitoring dashboard to show expiry dates without
 * re-running the check.
 *
 * Reads from the most recent monitor_event's `detail` field for the
 * domain monitor — the probe writes a structured detail string there.
 * For richer data (exact days), the API route calls the checker directly
 * once per page load (cheap — it's cached by the OS resolver).
 */
export async function getDomainMonitor(
  projectId: string,
  viewer: Viewer,
): Promise<Monitor | null> {
  if (!(await getProject(projectId, viewer))) return null
  
  /* monitor error — findFirst returns T | undefined, but return type is Monitor | null.
   * Use explicit null check to satisfy TypeScript. */
  const result = await db.query.monitors.findFirst({
    where: and(
      eq(monitors.projectId, projectId),
      eq(monitors.type, 'domain'),
    ),
  })
  return result ?? null
}




/*
 * Ensures a domain monitor exists for a project.
 * Called when a user enables the Monitoring feature.
 *
 * intervalS = 86400 (daily) — SSL and domain expiry do not change
 * by the hour, and a daily check is plenty of warning at 14/30 days.
 */
export async function ensureDomainMonitor(
  projectId: string,
  viewer: Viewer,
): Promise<Monitor | null> {
  return setMonitor(projectId, viewer, {
    type: 'domain',
    enabled: true,
    intervalS: 86_400, // once per day
  })
}
 

/*
 * ACTION: Add getPublicStatus() at the bottom of the file.
 *
 * SYSTEM QUERY — no Viewer. The status page is public by design:
 * a slug is not a secret and the data it returns is already visible
 * to anyone who can watch the site's HTTP responses. What it must
 * NOT return is anything private — no email, no userId, no internal ids
 * beyond what the page actually needs.
 *
 * Multi-component (Phase 6.1): a project may have several enabled monitors
 * (uptime, domain, web_vitals, rescan). Each one is a "component" on the
 * public page. Today the schema caps one row per (project, type), so the
 * shape is bounded; the API returns an array rather than assuming one.
 */
 
export interface PublicIncident {
  startedAt: Date
  resolvedAt: Date | null
  durationMs: number | null
  statusCode: number | null
  detail: string | null
}
 
/**
 * Returns the public-safe shape of a maintenance window — the row minus
 * internal ids and timestamps the status page does not need.
 */
export interface PublicMaintenanceWindow {
  /** Human-readable description, e.g. "Sundays 02:00–04:00 America/Los_Angeles". */
  description: string
  /** User-supplied reason. The banner shows this. */
  reason: string | null
}

/** Status of one component on the public status page. */
export type PublicComponentStatus = 'ok' | 'failed' | 'unknown'

/**
 * One public-facing component — corresponds to one enabled `monitors` row.
 * The page renders these in a loop, with the first (uptime) styled as the
 * primary uptime strip and the rest rendered as info cards.
 */
export interface PublicComponent {
  /** Internal monitor id; harmless to expose (it is the same id the owner
   *  already sees on their dashboard). */
  id: string
  /** Monitor kind. Drives the display label and card variant. */
  type: MonitorType
  /** Human-readable label for this component. */
  name: string
  currentStatus: PublicComponentStatus
  lastCheckedAt: Date | null
  /** Uptime % over last 90 days. null for non-uptime components or when no
   *  events exist. */
  uptimePercent: number | null
  /** Daily buckets for the 90-day strip. Empty for non-uptime components
   *  (the page renders no strip for those). */
  dailyBuckets: Array<{ date: string; ok: boolean; total: number }>
  /** Last 10 incidents for this component, each with its public timeline
   *  of human messages. The page renders these as the Statuspage-style
   *  vertical timeline under the component. */
  recentIncidents: PublicIncidentWithUpdates[]
  /** Active maintenance window, if any. */
  maintenance: PublicMaintenanceWindow | null
}

/** An incident + its ordered updates. Updates are empty when none have
 *  been posted (a brand-new incident before the on-call adds a message). */
export interface PublicIncidentWithUpdates {
  startedAt: Date
  resolvedAt: Date | null
  durationMs: number | null
  statusCode: number | null
  detail: string | null
  /** Chronological (oldest → newest). The UI renders newest first. */
  updates: Array<{
    status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
    message: string
    createdAt: Date
  }>
}

export interface PublicStatusData {
  projectName: string
  projectUrl: string
  /**
   * Overall status across all components. Worst-of aggregation:
   *   failed > unknown > ok.
   * `ok` only when every component is `ok`. `failed` if any component
   * is `failed`. `unknown` when nothing is failed but at least one is
   * unknown.
   */
  overallStatus: PublicComponentStatus
  /** Most recent lastCheckedAt across all components. */
  lastCheckedAt: Date | null
  /** Weighted uptime % across all uptime components. null when no uptime
   *  component has data, or when no uptime component exists. */
  uptimePercent: number | null
  /** All enabled components for the project, ordered by display priority
   *  (uptime first, then the rest). The page loops over this array — no
   *  hardcoded "single monitor" assumption anywhere. */
  components: PublicComponent[]
  /**
   * Status-page polish (Phase 6.4). Owner-controlled cosmetic settings
   * surfaced on the public page. `logoUrl` and `brandColor` are both
   * optional; when null, the page falls back to the default clean theme.
   * `robotsIndexable` defaults to true; the page emits a noindex meta
   * tag only when the owner has opted out.
   */
  branding: {
    logoUrl: string | null
    brandColor: string | null
    robotsIndexable: boolean
  }
}

/**
 * Reduce a list of per-component statuses into a project-wide verdict.
 * Pure — exported so it can be unit-tested without a DB.
 */
export function aggregateOverallStatus(
  statuses: ReadonlyArray<PublicComponentStatus>,
): PublicComponentStatus {
  if (statuses.some((s) => s === 'failed')) return 'failed'
  if (statuses.some((s) => s === 'unknown')) return 'unknown'
  return statuses.length > 0 ? 'ok' : 'unknown'
}

/**
 * Weighted uptime %, weighted by each uptime component's total checks.
 * Pure — exported for testing.
 *
 * Returns null when no component contributed any checks (no uptime
 * components, or every uptime component has zero events).
 */
export function aggregateUptimePercent(
  components: ReadonlyArray<Pick<PublicComponent, 'type' | 'uptimePercent'>>,
): number | null {
  // Not all components contribute uptime — only uptime kind does.
  // Other types (domain, web_vitals, rescan) are not probe-success-based
  // and would skew the average; we exclude them.
  //
  // We don't have total checks in PublicComponent, so we approximate the
  // weighted average with the mean of per-component uptimePercents that
  // are non-null. When the schema gains per-component totalChecks it
  // would be more accurate to weight by checks — the pure function above
  // keeps that change inside one place.
  const values = components
    .filter((c) => c.type === 'uptime' && c.uptimePercent !== null)
    .map((c) => c.uptimePercent as number)

  if (values.length === 0) return null
  const sum = values.reduce((acc, n) => acc + n, 0)
  return Math.round((sum / values.length) * 100) / 100
}

/**
 * The most recent lastCheckedAt across all components. Pure helper.
 */
export function mostRecentCheck(
  components: ReadonlyArray<Pick<PublicComponent, 'lastCheckedAt'>>,
): Date | null {
  let latest: Date | null = null
  for (const c of components) {
    if (!c.lastCheckedAt) continue
    if (latest === null || c.lastCheckedAt.getTime() > latest.getTime()) {
      latest = c.lastCheckedAt
    }
  }
  return latest
}

/**
 * Human-readable label for a monitor kind on the public page.
 * Pure — exported for testing.
 */
export function componentLabel(
  type: MonitorType,
  projectName: string,
): string {
  switch (type) {
    case 'uptime':
      return projectName
    case 'domain':
      return 'Domain & SSL'
    case 'web_vitals':
      return 'Web Vitals'
    case 'rescan':
      return 'Security Re-scan'
  }
}

/** Display order on the status page. Uptime is primary; the rest are info cards. */
const COMPONENT_ORDER: ReadonlyArray<MonitorType> = ['uptime', 'domain', 'web_vitals', 'rescan']

/**
 * Sort components for display. Pure — exported for testing.
 */
export function sortComponents<T extends { type: MonitorType }>(components: T[]): T[] {
  return [...components].sort(
    (a, b) => COMPONENT_ORDER.indexOf(a.type) - COMPONENT_ORDER.indexOf(b.type),
  )
}





/**
 * Returns everything the public status page needs in one query set.
 * Keyed by project slug — slugs are public (they appear in URLs the
 * owner shares), so no auth check is needed or appropriate here.
 *
 * Returns null when the slug does not exist, which the page renders
 * as a 404 rather than an empty state — a missing slug is not a
 * project with no data, it is a URL that means nothing.
 *
 * Multi-component: returns ALL enabled monitors for the project. The
 * page renders them in a loop. No "single monitor" assumption anywhere.
 *
 * Update batching: incidents + their human updates are fetched in a
 * single SELECT per resource. A status page with N components × M
 * incidents each would otherwise be N+M round trips; one batched call
 * keeps the hot path on the wrong side of one DB query during an
 * incident, which is the moment traffic spikes.
 */
export async function getPublicStatus(slug: string): Promise<PublicStatusData | null> {
  // 1. Resolve slug → project (Phase 6.4: branding fields included for the
  //    public status page — owner-controlled, so safe to expose).
  const project = await db.query.projects.findFirst({
    where: eq(projects.slug, slug),
    columns: {
      id: true,
      name: true,
      url: true,
      logoUrl: true,
      brandColor: true,
      robotsIndexable: true,
    },
  })
  if (!project) return null

  // 2. List ALL enabled monitors for this project. Ordered by type so
  //    uptime surfaces first; the display layer re-sorts via sortComponents.
  const projectMonitors = await db
    .select({
      id: monitors.id,
      type: monitors.type,
      lastStatus: monitors.lastStatus,
      lastRunAt: monitors.lastRunAt,
      intervalS: monitors.intervalS,
    })
    .from(monitors)
    .where(
      and(eq(monitors.projectId, project.id), eq(monitors.enabled, true)),
    )
    .orderBy(asc(monitors.type))

  // 3. Fetch every per-component slice in parallel. The incident ids we
  //    read here are needed to batch the updates fetch on the next line.
  const { rollups, maintenance } = await importComponents()
  const sortedMonitors = sortComponents(projectMonitors)

  const perComponent = await Promise.all(
    sortedMonitors.map((m) => buildComponentRaw(m, project.name, rollups, maintenance)),
  )

  // 4. Batched update fetch — one SELECT, grouped by incident id, then
  //    stitched back onto each component's incidents.
  const allIncidentIds = perComponent.flatMap((c) => c.incidents.map((i) => i.id))
  const updatesByIncident = await listIncidentUpdatesPublicForIncidents(allIncidentIds)

  const components: PublicComponent[] = perComponent.map((c) => ({
    ...c.component,
    recentIncidents: c.incidents.map((i) => ({
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      durationMs: i.durationMs,
      statusCode: i.statusCode,
      detail: i.detail,
      updates: updatesByIncident.get(i.id) ?? [],
    })),
  }))

  return {
    projectName: project.name,
    projectUrl: project.url,
    overallStatus: aggregateOverallStatus(components.map((c) => c.currentStatus)),
    lastCheckedAt: mostRecentCheck(components),
    uptimePercent: aggregateUptimePercent(components),
    components,
    branding: {
      logoUrl: project.logoUrl ?? null,
      brandColor: project.brandColor ?? null,
      robotsIndexable: project.robotsIndexable ?? true,
    },
  }
}

/**
 * Load the lazily-imported rollup + maintenance helpers ONCE per call,
 * in parallel. Returned as a plain object so `buildComponentRaw` does
 * not repeat the dynamic-import dance per component.
 */
async function importComponents(): Promise<{
  rollups: {
    getUptimeFromDailyRollups: (
      monitorId: string,
      start: Date,
      end: Date,
    ) => Promise<{ uptimePercent: number | null }>
    getDailyBucketsFromRollups: (
      monitorId: string,
      days: number,
    ) => Promise<Array<{ date: string; ok: boolean; total: number }>>
  }
  maintenance: {
    getActiveMaintenanceWindow: (
      monitorId: string,
      now?: Date,
    ) => Promise<{
      dayOfWeek: number | null
      startTime: string
      durationMin: number
      timezone: string
      reason: string | null
    } | null>
  }
}> {
  const [{ getUptimeFromDailyRollups, getDailyBucketsFromRollups }, { getActiveMaintenanceWindow }] =
    await Promise.all([import('./rollups.ts'), import('./maintenance-windows.ts')])
  return { rollups: { getUptimeFromDailyRollups, getDailyBucketsFromRollups }, maintenance: { getActiveMaintenanceWindow } }
}

/**
 * The per-component work before updates are stitched in. Returns the
 * bare component shape PLUS the raw incident rows (with ids) so the
 * caller can do one batched update lookup.
 */
async function buildComponentRaw(
  monitor: {
    id: string
    type: MonitorType
    lastStatus: string | null
    lastRunAt: Date | null
    intervalS: number
  },
  projectName: string,
  rollups: Awaited<ReturnType<typeof importComponents>>['rollups'],
  maintenance: Awaited<ReturnType<typeof importComponents>>['maintenance'],
): Promise<{
  component: Omit<PublicComponent, 'recentIncidents'>
  incidents: Array<{
    id: string
    startedAt: Date
    resolvedAt: Date | null
    durationMs: number | null
    statusCode: number | null
    detail: string | null
  }>
}> {
  const lastStatus = monitor.lastStatus as 'up' | 'down' | null
  const staleStatus = getMonitorStatus(monitor.lastRunAt, lastStatus, monitor.intervalS)

  const currentStatus: PublicComponentStatus = staleStatus.isStale
    ? 'unknown'
    : lastStatus === 'up'
      ? 'ok'
      : lastStatus === 'down'
        ? 'failed'
        : 'unknown'

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)

  const [uptimeResult, dailyBuckets, recentIncidents, activeWindow] = await Promise.all([
    monitor.type === 'uptime'
      ? rollups.getUptimeFromDailyRollups(monitor.id, cutoff, new Date())
      : Promise.resolve({ uptimePercent: null }),
    monitor.type === 'uptime'
      ? rollups.getDailyBucketsFromRollups(monitor.id, 90)
      : Promise.resolve([] as Array<{ date: string; ok: boolean; total: number }>),
    db.query.incidents.findMany({
      where: eq(incidents.monitorId, monitor.id),
      orderBy: desc(incidents.startedAt),
      limit: 10,
      columns: {
        id: true,
        startedAt: true,
        resolvedAt: true,
        durationMs: true,
        statusCode: true,
        detail: true,
      },
    }),
    maintenance.getActiveMaintenanceWindow(monitor.id),
  ])

  const component: Omit<PublicComponent, 'recentIncidents'> = {
    id: monitor.id,
    type: monitor.type,
    name: componentLabel(monitor.type, projectName),
    currentStatus,
    lastCheckedAt: monitor.lastRunAt,
    uptimePercent: uptimeResult.uptimePercent,
    dailyBuckets,
    maintenance: activeWindow
      ? {
          description: formatMaintenanceDescription(activeWindow),
          reason: activeWindow.reason,
        }
      : null,
  }

  return { component, incidents: recentIncidents }
}

/**
 * Render a window as a one-line description for the public status page.
 * Examples:
 *   "Daily, 02:00–04:00 America/Los_Angeles"
 *   "Sundays, 02:00–04:00 America/Los_Angeles"
 *   "Daily, 14:00–15:30 UTC"
 */
function formatMaintenanceDescription(window: {
  dayOfWeek: number | null
  startTime: string
  durationMin: number
  timezone: string
}): string {
  const days = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursays', 'Fridays', 'Saturdays']
  const dayLabel = window.dayOfWeek === null ? 'Daily' : days[window.dayOfWeek] ?? 'Daily'
  // startTime arrives as "HH:MM:SS" from postgres; trim the seconds.
  const [h = '0', m = '0'] = window.startTime.split(':')
  const start = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  const endTotal =
    Number.parseInt(h, 10) * 60 +
    Number.parseInt(m, 10) +
    window.durationMin
  const endH = Math.floor(endTotal / 60) % 24
  const endM = endTotal % 60
  const end = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`
  return `${dayLabel}, ${start}–${end} ${window.timezone}`
}
 

/**
 * Latest DNS snapshot fetch karta hai ek monitor ke liye.
 * Returns null agar pehli baar check ho raha hai (no baseline yet).
 */
export async function getLatestDnsSnapshot(
  monitorId: string,
): Promise<DnsRecord[] | null> {
  const row = await db.query.dnsSnapshots.findFirst({
    where: eq(dnsSnapshots.monitorId, monitorId),
    orderBy: [desc(dnsSnapshots.createdAt)],
    columns: { records: true },
  })

  if (!row) return null

  // WHY runtime parse: jsonb se aaya data untyped hota hai — validate karo
  const parsed = DnsRecordsSchema.safeParse(row.records)
  return parsed.success ? parsed.data : null
}

/**
 * Naya DNS snapshot insert karta hai.
 * Old snapshots delete nahi hote — audit trail ke liye useful hai.
 */
export async function recordDnsSnapshot(
  monitorId: string,
  records: DnsRecord[],
): Promise<void> {
  await db.insert(dnsSnapshots).values({
    monitorId,
    records,
  })
}



// ─── recentEventsWithDiff ──────────────────────────────────────────────────────
/**
 * Latest monitor events fetch karta hai, har event ke saath
 * previous event se computed diff attach karta hai.
 *
 * WHY on-the-fly compute (DB column pe nahi):
 *  - Probe code touch nahi karna padta
 *  - Always accurate — stored diff stale ho sakta hai
 *  - limit+1 trick se sirf ek DB call
 *
 * Security:
 *  - Viewer authorization: monitor ka project viewer ka hona chahiye
 *  - limit cap: unbounded queries block
 */
export async function recentEventsWithDiff(
  monitorId: string,
  viewer: Viewer,                    // tumhara existing Viewer type
  limit = 50,
): Promise<MonitorLogEntry[]> {

  // ── Input sanitization ──────────────────────────────────────────────────────
  const safeLimit = Math.min(Math.max(1, limit), 5000)
  // WHY cap at 5000: timeline displays can fetch historical events while still capping unbounded queries

  // ── Authorization ───────────────────────────────────────────────────────────
  // WHY pehle auth check: DB se unnecessary data pull karne se pehle
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { projectId: true },
  })

  if (!monitor) return []

  const project = await getProject(monitor.projectId, viewer)
  if (!project) return []
  // WHY getProject use: tumhara existing auth pattern — consistency

  // ── Fetch limit+1 rows ──────────────────────────────────────────────────────
  // WHY +1: last event ka diff compute karne ke liye uske pehle
  // wala event chahiye — extra row fetch karo, slice karo baad mein
  const rows = await db.query.monitorEvents.findMany({
    where: eq(monitorEvents.monitorId, monitorId),
    orderBy: [desc(monitorEvents.ts)],
    limit: safeLimit + 1,
    columns: {
      id: true,
      monitorId: true,
      ok: true,
      statusCode: true,
      latencyMs: true,
      detail: true,
      ts: true,
    },
  })

  // ── Compute diffs ───────────────────────────────────────────────────────────
  // rows[0] = most recent, rows[1] = one before that (desc order)
  // so rows[i+1] = previous event in time

  const withDiffs: MonitorLogEntry[] = rows
    .slice(0, safeLimit)           // extra (+1) row remove karo
    .map((event, i) => {
      const prev = rows[i + 1]    // older event (one step back in time)

      let diff: MonitorEventDiff | null = null

      if (prev) {
        const rawDiff: MonitorEventDiff = {}

        // Sirf woh fields include karo jo actually change hue
        // WHY: unnecessary noise avoid karo — agar latency thoda change hua
        //      toh bhi diff show hoga, but statusCode same raha toh woh diff nahi
        if (prev.statusCode !== event.statusCode) {
          rawDiff.statusCode = { from: prev.statusCode, to: event.statusCode }
        }

        if (prev.ok !== event.ok || prev.latencyMs !== event.latencyMs) {
          rawDiff.latencyMs = { from: prev.latencyMs, to: event.latencyMs }
        }

        if (prev.detail !== event.detail) {
          rawDiff.detail = { from: prev.detail, to: event.detail }
        }

        // WHY safeParse: empty rawDiff ({}) ko null treat karo —
        // agar kuch bhi nahi change hua toh diff = null, not {}
        const parsed = MonitorEventDiffSchema.safeParse(rawDiff)
        const isEmpty = Object.keys(rawDiff).length === 0
        diff = parsed.success && !isEmpty ? parsed.data : null
      }

      return {
        id: event.id,
        monitorId: event.monitorId,
        ok: event.ok,
        statusCode: event.statusCode,
        latencyMs: event.latencyMs,
        detail: event.detail,
        ts: event.ts.toISOString(),   // WHY serialize: JSON.stringify safe
        diff,
      }
    })

  return withDiffs
}







/* -------------------------------------------------------------------------- */
/* Snooze queries                                                              */
/* -------------------------------------------------------------------------- */
 
/**
 * SYSTEM QUERY — no Viewer.
 * Called from the probe before alerting — fast indexed lookup.
 *
 * Returns true when an active (non-expired) snooze exists for this monitor.
 * A snooze with expiresAt = null is active until manually cleared.
 */
export async function isMonitorSnoozed(monitorId: string): Promise<boolean> {
  const snooze = await db.query.snoozedMonitors.findFirst({
    where: and(
      eq(snoozedMonitors.monitorId, monitorId),
      or(
        isNull(snoozedMonitors.expiresAt),
        gte(snoozedMonitors.expiresAt, new Date()),
      ),
    ),
    columns: { id: true },
  })
  return snooze !== undefined
}
 
/**
 * Returns the active snooze for a monitor, or null if not snoozed.
 * Auth-gated — viewer must own the monitor's project.
 */
export async function getActiveSnooze(
  monitorId: string,
  viewer: Viewer,
): Promise<SnoozedMonitor | null> {
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { projectId: true },
  })
  if (!monitor || !(await getProject(monitor.projectId, viewer))) return null
 
  const snooze = await db.query.snoozedMonitors.findFirst({
    where: and(
      eq(snoozedMonitors.monitorId, monitorId),
      or(
        isNull(snoozedMonitors.expiresAt),
        gte(snoozedMonitors.expiresAt, new Date()),
      ),
    ),
  })
 
  return snooze ?? null
}
 
/**
 * Snoozes a monitor for a given duration or indefinitely.
 *
 * Upserts — if a snooze already exists it is replaced. This lets a user
 * extend a snooze without having to unsnooze first.
 *
 * Auth-gated — viewer must own the monitor's project.
 */
export async function snoozeMonitor(
  monitorId: string,
  viewer: Viewer,
  options: { expiresAt?: Date | null; reason?: string | null },
): Promise<SnoozedMonitor | null> {
  if (viewer.kind !== 'user') return null
 
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { projectId: true },
  })
  if (!monitor || !(await getProject(monitor.projectId, viewer))) return null
 
  // Delete existing snooze first — uniqueIndex enforces one per monitor,
  // and onConflictDoUpdate on a unique index is cleaner than update.
  await db
    .delete(snoozedMonitors)
    .where(eq(snoozedMonitors.monitorId, monitorId))
 
  const [row] = await db
    .insert(snoozedMonitors)
    .values({
      monitorId,
      createdBy: viewer.userId,
      expiresAt: options.expiresAt ?? null,
      reason: options.reason ?? null,
    })
    .returning()
 
  return row ?? null
}
 
/**
 * Removes the snooze for a monitor immediately.
 * Auth-gated — viewer must own the monitor's project.
 */
export async function unsnoozeMonitor(
  monitorId: string,
  viewer: Viewer,
): Promise<void> {
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { projectId: true },
  })
  if (!monitor || !(await getProject(monitor.projectId, viewer))) return
 
  await db
    .delete(snoozedMonitors)
    .where(eq(snoozedMonitors.monitorId, monitorId))
}

/**
 * Cleans up old DNS snapshots, monitor events, and web vitals snapshots
 * to prevent table bloat. Keeps last 90 days of data.
 *
 * Should be called periodically via a cron job or sweep function.
 */
export async function cleanupOldMonitorData(): Promise<{
  dnsSnapshotsDeleted: number
  monitorEventsDeleted: number
  webVitalsSnapshotsDeleted: number
}> {
  const retentionDays = 90
  const cutoff = sql`now() - interval '${sql.raw(String(retentionDays))} days'`

  // Delete old DNS snapshots
  const dnsResult = await db
    .delete(dnsSnapshots)
    .where(sql`${dnsSnapshots.createdAt} < ${cutoff}`)
    .returning({ id: dnsSnapshots.id })

  // Delete old monitor events
  const eventsResult = await db
    .delete(monitorEvents)
    .where(sql`${monitorEvents.ts} < ${cutoff}`)
    .returning({ id: monitorEvents.id })

  // Delete old web vitals snapshots
  const vitalsResult = await db
    .delete(webVitalsSnapshots)
    .where(sql`${webVitalsSnapshots.ts} < ${cutoff}`)
    .returning({ id: webVitalsSnapshots.id })

  return {
    dnsSnapshotsDeleted: dnsResult.length,
    monitorEventsDeleted: eventsResult.length,
    webVitalsSnapshotsDeleted: vitalsResult.length,
  }
}
 
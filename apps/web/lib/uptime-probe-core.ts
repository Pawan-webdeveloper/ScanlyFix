/**
 * FILE: apps/web/lib/uptime-probe-core.ts
 *
 * Core execution engine for uptime monitoring.
 *
 * Designed to be called from BOTH:
 *   1. The background Inngest worker (apps/web/inngest/functions/uptime-probe.ts)
 *   2. On-demand manual triggers (POST /api/monitors/[id]/run)
 *   3. On-demand page polls when a monitor is due (GET /api/monitors/[id])
 *
 * This eliminates the single point of failure where a monitor only executes
 * if a background Inngest daemon is actively running.
 */

import 'server-only'
import { safeFetch } from '@scanlyfix/checks'
import {
  consecutiveFailures,
  createIncident,
  getAlertChannels,
  getOpenIncident,
  isInMaintenanceWindow,
  isMonitorSnoozed,
  recordAlertOnce,
  recordMonitorRun,
  resolveIncident,
  db,
  monitors,
  projects,
} from '@scanlyfix/db'
import { eq } from 'drizzle-orm'
import { deliverAlert, resolveNotifyChannels } from '@/lib/alert-email.ts'
import { evaluateOutcome, AlertConfigSchema, type AlertConfig } from '@/lib/alert-threshold.ts'
import { prepareHeaders } from '@/lib/header-encryption.ts'
import { notifyConfirmedSubscribersForMonitor } from '@/lib/status-subscriber-email.ts'

const PROBE_TIMEOUT_MS = 15_000
const FAILURES_BEFORE_ALERT_DEFAULT = 1
const KEYWORD_CHECK_MAX_BODY_BYTES = 65536

export interface ExecuteUptimeProbeInput {
  monitorId: string
  projectId: string
  url: string
}

export interface ProbeResult {
  ok: boolean
  statusCode: number | null
  latencyMs: number
  detail: string | null
  alerted: boolean
  alertId: string | null
  streak: number
  recovered?: boolean
  downFor?: string
  snoozed?: boolean
  maintenance?: boolean
}

function resolveFailuresBeforeAlert(alertConfig: AlertConfig | null): number {
  const v = alertConfig?.failuresBeforeAlert
  if (typeof v !== 'number') return FAILURES_BEFORE_ALERT_DEFAULT
  if (!Number.isInteger(v)) return FAILURES_BEFORE_ALERT_DEFAULT
  if (v < 1 || v > 5) return FAILURES_BEFORE_ALERT_DEFAULT
  return v
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function humanizeDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

function getReminderSlot(startedAt: Date, intervalMin: number): number {
  const now = Date.now()
  const elapsed = now - startedAt.getTime()
  const intervalMs = intervalMin * 60 * 1000
  return Math.floor(elapsed / intervalMs)
}

/**
 * Runs a full probe check against a target URL, records the result in the database,
 * updates incidents, and sends email alerts if state transitions occur.
 */
export async function executeUptimeProbe({
  monitorId,
  projectId,
  url,
}: ExecuteUptimeProbeInput): Promise<ProbeResult> {
  // Validate URL format
  try {
    new URL(url)
  } catch {
    return {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      detail: 'unparseable project URL',
      alerted: false,
      alertId: null,
      streak: 0,
    }
  }

  // 1. Fetch monitor configuration
  const monitorRow = await db.query.monitors.findFirst({
    where: eq(monitors.id, monitorId),
    columns: { alertConfig: true },
  })

  let alertConfig: AlertConfig | null = null
  if (monitorRow?.alertConfig) {
    const parsed = AlertConfigSchema.safeParse(monitorRow.alertConfig)
    alertConfig = parsed.success ? parsed.data : null
  }

  const method = alertConfig?.httpMethod ?? 'GET'
  const followRedirects = alertConfig?.followRedirects ?? true
  const customHeaders = alertConfig?.customHeaders
    ? prepareHeaders(alertConfig.customHeaders)
    : {}
  const needsBody = alertConfig?.keywordCheck !== undefined
  const maxBodyBytes = needsBody ? KEYWORD_CHECK_MAX_BODY_BYTES : 4096

  // 2. Perform HTTP probe
  const startedAt = Date.now()
  let outcome: {
    ok: boolean
    statusCode: number | null
    latencyMs: number
    detail: string | null
    alertConfig: AlertConfig | null
  }

  try {
    const response = await safeFetch(url, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBodyBytes,
      followRedirects,
      headers: customHeaders,
    })
    const latencyMs = Date.now() - startedAt
    const statusCode = response.status
    const body = needsBody ? response.body : undefined

    const { ok, reason } = evaluateOutcome({ statusCode, latencyMs, body }, alertConfig)
    let detail: string | null = null
    if (!ok) {
      detail = reason ?? `HTTP ${statusCode}`
    }

    outcome = {
      ok,
      statusCode,
      latencyMs,
      detail,
      alertConfig,
    }
  } catch (error) {
    outcome = {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : 'unreachable',
      alertConfig,
    }
  }

  // 3. Record the event and advance lastRunAt
  await recordMonitorRun(monitorId, outcome)

  // 4. Handle recovery or downtime state transitions
  if (outcome.ok) {
    const resolvedIncidents = await resolveIncident(monitorId)
    if (resolvedIncidents.length > 0) {
      const incident = resolvedIncidents[0]!
      const downFor = humanizeDuration(incident.durationMs)
      const snoozed = await isMonitorSnoozed(monitorId)
      if (!snoozed) {
        const inMaintenance = await isInMaintenanceWindow(monitorId)
        if (!inMaintenance) {
          const alert = await recordAlertOnce({
            projectId,
            kind: 'recovered',
            channel: 'email',
            payload: {
              url,
              downFor,
              recoveredAt: new Date().toISOString(),
              incidentId: incident.id,
              statusCode: incident.statusCode,
              detail: incident.detail,
              alertEmail: alertConfig?.alertEmail ?? null,
            },
          })

          if (alert) {
            const [project] = await db
              .select({ name: projects.name, url: projects.url, slug: projects.slug })
              .from(projects)
              .where(eq(projects.id, projectId))
              .limit(1)
            if (project) {
              await notifyConfirmedSubscribersForMonitor({
                monitorId,
                email: {
                  projectName: project.name,
                  projectUrl: project.url,
                  projectSlug: project.slug,
                  incidentId: incident.id,
                  stage: 'resolved',
                  headline: `${hostOf(project.url)} is back up`,
                  message: `${project.name} is responding normally again. Was down for ${downFor}.`,
                  isInitial: false,
                },
              }).catch((err) => console.error('[alert] Subscriber notify failed:', err))
            }

            try {
              const channels = await getAlertChannels(projectId)
              const enabledIds = channels.filter((c) => c.enabled).map((c) => c.id)
              const routing = resolveNotifyChannels(alertConfig ?? null, enabledIds)
              await deliverAlert(alert.id, routing)
            } catch (err) {
              console.error('[alert] Recovery delivery failed:', err)
            }

            return {
              ok: true,
              statusCode: outcome.statusCode,
              latencyMs: outcome.latencyMs,
              detail: null,
              alerted: true,
              alertId: alert.id,
              streak: 0,
              recovered: true,
              downFor,
            }
          }
        }
      }
    }

    return {
      ok: true,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      detail: null,
      alerted: false,
      alertId: null,
      streak: 0,
      recovered: false,
    }
  }

  // 5. Outcome is DOWN
  const streak = await consecutiveFailures(monitorId)
  const failuresBeforeAlert = resolveFailuresBeforeAlert(outcome.alertConfig)

  if (streak < failuresBeforeAlert) {
    return {
      ok: false,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      detail: outcome.detail,
      alerted: false,
      streak,
      alertId: null,
    }
  }

  const snoozed = await isMonitorSnoozed(monitorId)
  if (snoozed) {
    return {
      ok: false,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      detail: outcome.detail,
      alerted: false,
      streak,
      alertId: null,
      snoozed: true,
    }
  }

  const inMaintenance = await isInMaintenanceWindow(monitorId)
  if (inMaintenance) {
    return {
      ok: false,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      detail: outcome.detail,
      alerted: false,
      streak,
      alertId: null,
      maintenance: true,
    }
  }

  const openIncident = await getOpenIncident(monitorId)
  const incident =
    openIncident ??
    (await createIncident(monitorId, {
      statusCode: outcome.statusCode,
      detail: outcome.detail,
    }))

  if (!incident) {
    return {
      ok: false,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      detail: outcome.detail,
      alerted: false,
      streak,
      alertId: null,
    }
  }

  const initialDedupKey = `downtime-initial-${incident.id}`
  const alert = await recordAlertOnce({
    projectId,
    kind: 'downtime',
    channel: 'email',
    payload: {
      url,
      streak,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      detail: outcome.detail,
      alertEmail: alertConfig?.alertEmail ?? null,
    },
    dedupKey: initialDedupKey,
  })

  if (alert) {
    if (!openIncident) {
      const [project] = await db
        .select({ name: projects.name, url: projects.url, slug: projects.slug })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1)
      if (project) {
        const observed = outcome.statusCode
          ? `HTTP ${outcome.statusCode}`
          : outcome.detail ?? 'no response'
        await notifyConfirmedSubscribersForMonitor({
          monitorId,
          email: {
            projectName: project.name,
            projectUrl: project.url,
            projectSlug: project.slug,
            incidentId: incident.id,
            stage: 'investigating',
            headline: `${hostOf(project.url)} is not responding`,
            message: `${project.name} has failed ${streak} consecutive checks. Observed: ${observed}. We are investigating.`,
            isInitial: true,
          },
        }).catch((err) => console.error('[alert] Subscriber notify failed:', err))
      }
    }

    try {
      const channels = await getAlertChannels(projectId)
      const enabledIds = channels.filter((c) => c.enabled).map((c) => c.id)
      const routing = resolveNotifyChannels(outcome.alertConfig ?? null, enabledIds)
      await deliverAlert(alert.id, routing)
    } catch (err) {
      console.error('[alert] Downtime delivery failed:', err)
    }

    return {
      ok: false,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      detail: outcome.detail,
      alerted: true,
      streak,
      alertId: alert.id,
    }
  }

  // Initial alert already sent — check reminders if configured
  const reminderIntervalMin = alertConfig?.reminderIntervalMin
  if (reminderIntervalMin) {
    const currentSlot = getReminderSlot(incident.startedAt, reminderIntervalMin)
    if (currentSlot > 0) {
      const dedupKey = `downtime-${monitorId}-${incident.id}-reminder-${currentSlot}`
      const reminderAlert = await recordAlertOnce({
        projectId,
        kind: 'downtime-reminder',
        channel: 'email',
        payload: {
          url,
          streak,
          statusCode: outcome.statusCode,
          latencyMs: outcome.latencyMs,
          detail: outcome.detail,
          reminderNumber: currentSlot,
          downFor: humanizeDuration(Date.now() - incident.startedAt.getTime()),
          alertEmail: alertConfig?.alertEmail ?? null,
        },
        dedupKey,
      })

      if (reminderAlert) {
        try {
          const channels = await getAlertChannels(projectId)
          const enabledIds = channels.filter((c) => c.enabled).map((c) => c.id)
          const routing = resolveNotifyChannels(outcome.alertConfig ?? null, enabledIds)
          await deliverAlert(reminderAlert.id, routing)
        } catch (err) {
          console.error('[alert] Reminder delivery failed:', err)
        }

        return {
          ok: false,
          statusCode: outcome.statusCode,
          latencyMs: outcome.latencyMs,
          detail: outcome.detail,
          alerted: true,
          streak,
          alertId: reminderAlert.id,
        }
      }
    }
  }

  return {
    ok: false,
    statusCode: outcome.statusCode,
    latencyMs: outcome.latencyMs,
    detail: outcome.detail,
    alerted: false,
    streak,
    alertId: null,
  }
}

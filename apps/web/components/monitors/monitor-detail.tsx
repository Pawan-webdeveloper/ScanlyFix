'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { StatusDot } from './status-dot'
import { UptimeBadge } from './uptime-badge'
import { ResponseTimeChart } from './response-time-chart'
import { IncidentsList } from './incidents-list'
import { DiffBadge } from '@/components/monitors/diff-badge'
import { MonitorSettings } from '@/components/monitors/monitor-settings.tsx'
import { SnoozeButton } from './snooze-button'
import { RunCheckButton } from './run-check-button'
import { Icon } from '@/components/console/icons.tsx'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface LogEntry {
  id: string
  ok: boolean
  statusCode: number | null
  latencyMs: number | null
  ts: string
  detail: string | null
  diff: {
    statusCode?: { from: number | null; to: number | null }
    latencyMs?: { from: number | null; to: number | null }
    detail?: { from: string | null; to: string | null }
  } | null
}

interface Incident {
  id: string
  startedAt: string
  resolvedAt: string | null
  durationMs: number | null
  statusCode: number | null
  detail: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  acknowledgerEmail: string | null
  notes: string | null
}

interface UptimeData {
  uptimePercent: number | null
  total: number
  up: number
  down: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
}

interface MonitorData {
  id: string
  type: 'uptime' | 'rescan' | 'domain' | 'web_vitals'
  projectName: string
  projectUrl: string
  lastStatus: 'up' | 'down' | null
  lastRunAt: string | null
  lastStatusCode: number | null
  lastLatencyMs: number | null
  lastDetail: string | null
  intervalS: number
  enabled: boolean
}

interface ResponseTimeDataPoint {
  timestamp: string
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  maxLatencyMs: number | null
  totalChecks: number
}

interface MonitorDetailProps {
  monitor: MonitorData
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function formatInterval(s: number): string {
  if (s >= 86400) return 'daily'
  if (s < 60) return `${s}s`
  return `${Math.round(s / 60)}m`
}

function statusCodeLabel(
  status: 'up' | 'down' | 'disabled' | null,
  code: number | null,
): string {
  if (status === 'up') return code !== null ? `UP · ${code}` : 'UP'
  if (status === 'down') return code !== null ? `DOWN · ${code}` : 'DOWN'
  if (status === 'disabled') return 'PAUSED'
  return 'Pending'
}

/* -------------------------------------------------------------------------- */
/* Card — dashboard's shared card primitive                                    */
/* -------------------------------------------------------------------------- */

function Card({
  title,
  action,
  children,
  className = '',
  noPad = false,
}: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  noPad?: boolean
}) {
  return (
    <section
      className={`overflow-hidden rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {(title || action) && (
        <header className="flex items-center justify-between gap-4 border-b border-c-line px-6 py-4">
          {title && <h2 className="text-sm font-medium text-c-ink">{title}</h2>}
          {action}
        </header>
      )}
      {noPad ? children : <div className="px-6 py-5">{children}</div>}
    </section>
  )
}

/** Period / range selector tabs, styled to the dashboard's active-tab token */
function PeriodTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-c-line bg-c-soft p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
            value === opt
              ? 'bg-c-card text-c-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
              : 'text-c-muted hover:text-c-ink'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* MiniStat — inline stat cell for the "Recent checks" footer strip           */
/* -------------------------------------------------------------------------- */

function MiniStat({
  icon,
  label,
  value,
  hint,
  divider = false,
}: {
  icon: React.ComponentProps<typeof Icon>['name']
  label: string
  value: string
  hint?: string
  divider?: boolean
}) {
  return (
    <div className={`px-6 py-5 ${divider ? 'border-l border-c-line' : ''}`}>
      <p className="flex items-center gap-2 text-[12px] font-medium text-c-muted">
        <Icon name={icon} size={14} />
        {label}
      </p>
      <p className="console-num mt-2 text-2xl font-semibold leading-none tracking-tight text-c-ink">
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[12px] text-c-muted">{hint}</p>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* MonitorDetail                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The uptime monitor detail view.
 *
 * All sections use the dashboard's Card + c-* token vocabulary.
 * The live-status header mirrors the dashboard's BigStat strip: a status dot
 * inside a rounded icon box, project name as primary text, URL as secondary.
 * Polling intervals and visibility-refresh logic are unchanged.
 */
export function MonitorDetail({ monitor }: MonitorDetailProps) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [uptime, setUptime] = useState<UptimeData | null>(null)
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('7d')
  const [responseTimeRange, setResponseTimeRange] = useState<'1h' | '24h' | '7d'>('24h')
  const [responseTimeData, setResponseTimeData] = useState<ResponseTimeDataPoint[]>([])
  const [logsError, setLogsError] = useState<string | null>(null)
  const [uptimeError, setUptimeError] = useState<string | null>(null)
  const [incidentsError, setIncidentsError] = useState<string | null>(null)
  const [responseTimeError, setResponseTimeError] = useState<string | null>(null)
  const [liveStatus, setLiveStatus] = useState<MonitorData>(monitor)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  /* ── Fetchers ──────────────────────────────────────────────────────────── */

  const loadLogs = useCallback(() => {
    fetch(`/api/monitors/${monitor.id}/logs`)
      .then((r) => { if (!r.ok) throw new Error('Failed to load logs'); return r.json() })
      .then((d) => { if (!mountedRef.current) return; setLogs(d.logs ?? []); setLogsError(null) })
      .catch((e: unknown) => { if (!mountedRef.current) return; setLogsError(e instanceof Error ? e.message : 'Failed to load logs') })
  }, [monitor.id])

  const loadUptime = useCallback(() => {
    fetch(`/api/monitors/${monitor.id}/uptime?period=${period}`)
      .then((r) => { if (!r.ok) throw new Error('Failed to load uptime'); return r.json() })
      .then((d) => { if (!mountedRef.current) return; setUptime(d); setUptimeError(null) })
      .catch((e: unknown) => { if (!mountedRef.current) return; setUptimeError(e instanceof Error ? e.message : 'Failed to load uptime') })
  }, [monitor.id, period])

  const loadResponseTimes = useCallback(() => {
    fetch(`/api/monitors/${monitor.id}/response-times?range=${responseTimeRange}`)
      .then((r) => { if (!r.ok) throw new Error('Failed to load response times'); return r.json() })
      .then((d) => { if (!mountedRef.current) return; setResponseTimeData(d.data ?? []); setResponseTimeError(null) })
      .catch((e: unknown) => { if (!mountedRef.current) return; setResponseTimeError(e instanceof Error ? e.message : 'Failed to load response times') })
  }, [monitor.id, responseTimeRange])

  const loadIncidents = useCallback(() => {
    fetch(`/api/monitors/${monitor.id}/incidents`)
      .then((r) => { if (!r.ok) throw new Error('Failed to load incidents'); return r.json() })
      .then((d) => { if (!mountedRef.current) return; setIncidents(d.incidents ?? []); setIncidentsError(null) })
      .catch((e: unknown) => { if (!mountedRef.current) return; setIncidentsError(e instanceof Error ? e.message : 'Failed to load incidents') })
  }, [monitor.id])

  const loadLiveStatus = useCallback(() => {
    fetch(`/api/monitors/${monitor.id}`)
      .then((r) => { if (!r.ok) return null; return r.json() })
      .then((d: { monitor?: Partial<MonitorData> } | null) => {
        if (!mountedRef.current || !d?.monitor) return
        setLiveStatus((prev) => ({ ...prev, ...d.monitor }))
      })
      .catch(() => null)
  }, [monitor.id])

  /* ── Effects ───────────────────────────────────────────────────────────── */

  useEffect(() => { loadLogs(); const id = setInterval(loadLogs, 15_000); return () => clearInterval(id) }, [loadLogs])
  useEffect(() => { loadUptime(); const id = setInterval(loadUptime, 30_000); return () => clearInterval(id) }, [loadUptime])
  useEffect(() => { loadResponseTimes(); const id = setInterval(loadResponseTimes, 30_000); return () => clearInterval(id) }, [loadResponseTimes])
  useEffect(() => { loadIncidents(); const id = setInterval(loadIncidents, 30_000); return () => clearInterval(id) }, [loadIncidents])
  useEffect(() => { loadLiveStatus(); const id = setInterval(loadLiveStatus, 15_000); return () => clearInterval(id) }, [loadLiveStatus])

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      loadLiveStatus(); loadLogs(); loadUptime(); loadIncidents(); loadResponseTimes()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadLiveStatus, loadLogs, loadUptime, loadIncidents, loadResponseTimes])

  /* ── Derived ───────────────────────────────────────────────────────────── */

  const avgLatency =
    logs.length > 0
      ? Math.round(logs.reduce((s, l) => s + (l.latencyMs ?? 0), 0) / logs.length)
      : null

  /* ── Render ────────────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col gap-6">

      {/* ── Status header ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Left: status dot + name */}
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-c-line bg-c-soft">
            <StatusDot status={liveStatus.lastStatus} size="md" />
          </span>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-c-ink">{monitor.projectName}</h1>
            <p className="mt-0.5 truncate font-mono text-[12px] text-c-muted">
              {monitor.projectUrl}
            </p>
          </div>
        </div>

        {/* Right: Run check + status pill */}
        <div className="flex items-center gap-3">
          <RunCheckButton
            monitorId={monitor.id}
            baseline={
              logs[0] !== undefined
                ? { firstId: logs[0].id, firstTs: logs[0].ts }
                : null
            }
            onChecked={() => { loadLogs(); loadUptime(); loadLiveStatus() }}
          />
          <span
            title={liveStatus.lastDetail ?? undefined}
            className={`console-num rounded-md border px-3 py-1.5 font-mono text-[12px] font-medium ${
              liveStatus.lastStatus === 'up'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : liveStatus.lastStatus === 'down'
                  ? 'border-sev-critical/30 bg-sev-critical/10 text-sev-critical'
                  : liveStatus.lastStatus === 'disabled'
                    ? 'border-c-line bg-c-soft text-c-muted'
                    : 'border-c-line bg-c-soft text-c-muted'
            }`}
          >
            {statusCodeLabel(liveStatus.lastStatus as 'up' | 'down' | 'disabled' | null, liveStatus.lastStatusCode)}
          </span>
        </div>
      </div>

      {/* ── Snooze (uptime only) ─────────────────────────────────────────── */}
      {monitor.type === 'uptime' && (
        <SnoozeButton monitorId={monitor.id} onChanged={loadLogs} />
      )}

      {/* ── Stats strip ─────────────────────────────────────────────────── */}
      <section
        className="overflow-hidden rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
        aria-label="Monitor stats"
      >
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <div className="px-6 py-5">
            <p className="flex items-center gap-2 text-[12px] font-medium text-c-muted">
              <Icon name="uptime" size={14} />
              Uptime (7d)
            </p>
            <div className="mt-2">
              {uptime ? (
                <UptimeBadge percent={uptime.uptimePercent} />
              ) : (
                <span className="text-[12px] text-c-muted">—</span>
              )}
            </div>
          </div>
          <MiniStat
            icon="search"
            label="Response time"
            value={
              uptime?.avgLatencyMs != null
                ? `${uptime.avgLatencyMs}ms`
                : avgLatency !== null
                  ? `${avgLatency}ms`
                  : '—'
            }
            hint={uptime?.p95LatencyMs != null ? `p95 ${uptime.p95LatencyMs}ms` : undefined}
            divider
          />
          <MiniStat
            icon="bell"
            label="Last check"
            value={liveStatus.lastRunAt ? timeAgo(liveStatus.lastRunAt) : 'never'}
            divider
          />
          <MiniStat
            icon="globe"
            label="Interval"
            value={formatInterval(monitor.intervalS)}
            divider
          />
        </div>
      </section>

      {/* ── Response time chart ──────────────────────────────────────────── */}
      <Card
        title="Response time"
        action={
          <PeriodTabs
            options={['1h', '24h', '7d'] as const}
            value={responseTimeRange}
            onChange={setResponseTimeRange}
          />
        }
      >
        {responseTimeError ? (
          <p className="text-sm text-sev-critical">{responseTimeError}</p>
        ) : (
          <ResponseTimeChart
            data={responseTimeData}
            range={responseTimeRange}
            p95LatencyMs={uptime?.p95LatencyMs}
          />
        )}
      </Card>

      {/* ── Uptime % with period selector ───────────────────────────────── */}
      <Card
        title="Uptime"
        action={
          <PeriodTabs
            options={['24h', '7d', '30d'] as const}
            value={period}
            onChange={setPeriod}
          />
        }
      >
        {uptimeError ? (
          <p className="text-sm text-sev-critical">{uptimeError}</p>
        ) : uptime ? (
          <div className="flex flex-wrap items-center gap-4">
            <UptimeBadge percent={uptime.uptimePercent} />
            <span className="console-num text-[12px] text-c-muted">
              {uptime.up} up · {uptime.down} down · {uptime.total} total checks
            </span>
          </div>
        ) : (
          <div className="h-5 w-24 animate-pulse rounded-md bg-c-soft" />
        )}
      </Card>

      {/* ── Incidents ────────────────────────────────────────────────────── */}
      <Card
        title="Recent incidents"
        action={
          incidents.length > 0 ? (
            <span className="text-[12px] text-c-muted">{incidents.length} recorded</span>
          ) : null
        }
        noPad
      >
        {incidentsError ? (
          <p className="px-6 py-5 text-sm text-sev-critical">{incidentsError}</p>
        ) : (
          <div className="px-6">
            <IncidentsList incidents={incidents} />
          </div>
        )}
      </Card>

      {/* ── Alert settings (uptime only) ─────────────────────────────────── */}
      {monitor.type === 'uptime' && (
        <Card title="Alert settings">
          <MonitorSettings monitorId={monitor.id} />
        </Card>
      )}

      {/* ── Recent checks ────────────────────────────────────────────────── */}
      <Card
        title="Recent checks"
        noPad
        action={
          logsError ? (
            <button
              type="button"
              onClick={loadLogs}
              className="text-[12px] text-sev-critical underline"
            >
              Retry
            </button>
          ) : null
        }
      >
        {logsError ? (
          <p className="px-6 py-5 text-sm text-sev-critical">{logsError}</p>
        ) : logs.length === 0 ? (
          /* Skeleton rows */
          <ul>
            {[...Array(4)].map((_, i) => (
              <li
                key={i}
                className={`flex items-center gap-4 px-6 py-3.5 ${i > 0 ? 'border-t border-c-line' : ''}`}
              >
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-c-soft" />
                <span className="h-3.5 w-12 animate-pulse rounded bg-c-soft" />
                <span className="h-3.5 w-16 animate-pulse rounded bg-c-soft" />
                <span className="ml-auto h-3 w-14 animate-pulse rounded bg-c-soft" />
              </li>
            ))}
          </ul>
        ) : (
          <ul>
            {logs.map((log) => (
              <li
                key={log.id}
                className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-c-line"
              >
                <div className="px-6 py-3.5">
                  {/* Row: dot · status code · latency · time */}
                  <div className="flex items-center gap-3">
                    <StatusDot status={log.ok ? 'up' : 'down'} size="sm" />
                    <span className="console-num font-mono text-sm font-medium text-c-ink">
                      {log.statusCode ?? '—'}
                    </span>
                    <span className="console-num text-sm text-c-muted">
                      {log.latencyMs !== null ? `${log.latencyMs}ms` : '—'}
                    </span>
                    <span className="ml-auto console-num text-[12px] text-c-muted/70">
                      {timeAgo(log.ts)}
                    </span>
                  </div>
                  {/* Diff badge on the next line if present */}
                  {log.diff !== null && (
                    <div className="mt-2">
                      <DiffBadge diff={log.diff} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

    </div>
  )
}
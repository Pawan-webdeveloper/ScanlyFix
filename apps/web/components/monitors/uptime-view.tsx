'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AvailabilityTimeline } from './availability-timeline'
import { DowntimeHistory } from './downtime-history'
import { MonitorSettingsSection } from './monitor-settings-section'
import { StatsRow } from './stats-row'
import { StatusHero } from './status-hero'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface EventRow {
  ts: string
  ok: boolean
}

interface UptimeStats {
  total: number
  up: number
  down: number
  uptimePercent: number | null
  avgLatencyMs: number | null
}

interface IncidentEntry {
  id: string
  status: 'ongoing' | 'resolved'
  startedAt: string
  resolvedAt: string | null
  detail: string | null
  statusCode: number | null
}

interface UptimeViewProps {
  monitorId: string
  projectName: string
  projectUrl: string
  slug?: string | null
  initialStatus: 'up' | 'down' | null
  initialLastRunAt: string | null
  initialDownSince: string | null
  initialLastDetail: string | null
  initialFailuresBeforeAlert: 1 | 2 | 3 | 5
  initialAlertEmail: string | null
  intervalS: number
}

/* -------------------------------------------------------------------------- */
/* UptimeView                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The uptime page body, checkvibe-style.
 *
 * The page header (breadcrumb, project name, Refresh + Monitoring toggle)
 * lives outside this component. Everything inside is the timeline, stats,
 * downtime history and monitor settings cards.
 *
 * Live data: a single fetch on mount, then a 15-second poll. The poll is
 * intentionally cheap — only the `uptime` endpoint is hot; the incident
 * list and alert preferences only refresh on user action.
 */
export function UptimeView(props: UptimeViewProps) {
  const {
    monitorId,
    projectName,
    projectUrl,
    slug,
    initialStatus,
    initialLastRunAt,
    initialDownSince,
    initialFailuresBeforeAlert,
    initialAlertEmail,
    intervalS,
  } = props

  const [events, setEvents] = useState<EventRow[]>([])
  const [stats, setStats] = useState<UptimeStats | null>(null)
  const [stats24h, setStats24h] = useState<UptimeStats | null>(null)
  const [stats30d, setStats30d] = useState<UptimeStats | null>(null)
  const [incidents, setIncidents] = useState<IncidentEntry[]>([])
  // `null` = unknown (never run, or stale). NOT defaulting to 'up' because a
  // monitor that hasn't been probed recently MUST NOT claim to be up.
  const [status, setStatus] = useState<'up' | 'down' | null>(initialStatus)
  const [isStale, setIsStale] = useState(false)
  const [downSince, setDownSince] = useState<string | null>(initialDownSince)
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(initialLastRunAt)
  const [period, setPeriod] = useState<'7d' | '30d'>('30d')
  const [monitoringOn, setMonitoringOn] = useState(true)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /* ── Fetchers ────────────────────────────────────────────────────────── */

  const loadEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitors/${monitorId}/logs?limit=5000`)
      if (!res.ok) return
      const data = (await res.json()) as { logs?: EventRow[] }
      if (!mountedRef.current) return
      setEvents(data.logs ?? [])
    } catch {
      /* swallow — the timeline degrades to empty days if logs can't load */
    }
  }, [monitorId])

  const loadStats = useCallback(
    async (periodKey: '24h' | '7d' | '30d') => {
      try {
        const res = await fetch(
          `/api/monitors/${monitorId}/uptime?period=${periodKey}`,
        )
        if (!res.ok) return null
        const data = (await res.json()) as UptimeStats
        if (!mountedRef.current) return data
        if (periodKey === '24h') setStats24h(data)
        else if (periodKey === '7d') setStats(data)
        else setStats30d(data)
        return data
      } catch {
        return null
      }
    },
    [monitorId],
  )

  const loadIncidents = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitors/${monitorId}/incidents`)
      if (!res.ok) return
      const data = (await res.json()) as {
        incidents?: Array<{
          id: string
          startedAt: string
          resolvedAt: string | null
          detail: string | null
          statusCode: number | null
        }>
      }
      if (!mountedRef.current) return
      const list = data.incidents ?? []
      setIncidents(
        list.map((i) => ({
          id: i.id,
          startedAt: i.startedAt,
          resolvedAt: i.resolvedAt,
          detail: i.detail,
          statusCode: i.statusCode,
          status: i.resolvedAt ? 'resolved' : 'ongoing',
        })),
      )
      const open = list.find((i) => i.resolvedAt === null)
      if (open) {
        // Confirmed down — an open incident is ground truth.
        setStatus('down')
        setDownSince(open.startedAt)
      }
      // Note: we do NOT reset to 'up' here when there is no open incident.
      // loadLiveStatus is the authority for the live up/down/stale state;
      // incidents are the authority for "currently down since when".
    } catch {
      /* swallow — incidents are non-critical */
    }
  }, [monitorId])

  const loadLiveStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitors/${monitorId}`)
      if (!res.ok) return
      const data = (await res.json()) as {
        monitor?: {
          lastStatus: 'up' | 'down' | null
          lastRunAt: string | null
          isStale: boolean
        }
      }
      if (!mountedRef.current || !data.monitor) return

      setLastCheckedAt(data.monitor.lastRunAt)
      setIsStale(data.monitor.isStale)

      if (data.monitor.isStale) {
        // Worker is not running — the frozen lastStatus is unreliable.
        // Show unknown rather than lying about being up.
        setStatus(null)
      } else if (data.monitor.lastStatus) {
        setStatus(data.monitor.lastStatus)
        if (data.monitor.lastStatus === 'up') {
          // Live probe confirmed up — clear any stale downSince
          setDownSince(null)
        }
      }
    } catch {
      /* swallow */
    }
  }, [monitorId])

  /* ── Effects ─────────────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      // Each fetcher is fire-and-forget — they swallow their own errors so
      // a transient 5xx on /api/monitors does not freeze the timeline. The
      // timeline degrades gracefully; the next tick (15s later) re-tries
      // everything, so a single failed poll is invisible to the user.
      loadStats('24h')
      loadStats('7d')
      loadStats('30d')
      loadIncidents()
      loadLiveStatus()
    }

    tick()
    const id = setInterval(tick, 15_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [loadStats, loadIncidents, loadLiveStatus])

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      loadStats('24h')
      loadStats('7d')
      loadStats('30d')
      loadIncidents()
      loadLiveStatus()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadStats, loadIncidents, loadLiveStatus])

  useEffect(() => {
    // Load events once on mount — the timeline is a 90-day view, and the
    // 15s poll already updates the small "Down" pill. Re-fetching 5000
    // rows every 15s would burn API quota without changing what the user sees.
    loadEvents()
  }, [loadEvents])

  const [isChecking, setIsChecking] = useState(false)

  const handleRunCheck = useCallback(async () => {
    if (isChecking) return
    setIsChecking(true)
    try {
      // Trigger an immediate live probe check on the server
      await fetch(`/api/monitors/${monitorId}/run`, { method: 'POST' })
    } catch {
      /* swallow */
    } finally {
      // Re-fetch all monitor metrics to reflect the new state immediately
      await Promise.all([
        loadStats('24h'),
        loadStats('7d'),
        loadStats('30d'),
        loadIncidents(),
        loadLiveStatus(),
        loadEvents(),
      ])
      setIsChecking(false)
    }
  }, [monitorId, isChecking, loadStats, loadIncidents, loadLiveStatus, loadEvents])

  /* ── Derived ─────────────────────────────────────────────────────────── */

  const publicStatusHref = slug ? `/status/${slug}` : null

  /* ── Render ──────────────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col gap-6">
      {/* Project title row */}
      <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
        <div>
          <p className="font-mono text-xs text-gray-500">{projectUrl}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-900">
            {projectName}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRunCheck}
            disabled={isChecking}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-60"
          >
            <RefreshIcon className={isChecking ? 'animate-spin' : ''} />
            {isChecking ? 'Checking…' : 'Run check'}
          </button>
          <MonitoringToggle
            on={monitoringOn}
            onToggle={() => setMonitoringOn((prev) => !prev)}
          />
        </div>
      </header>

      {/* Status hero */}
      <StatusHero
        status={status}
        stateStartedAt={downSince}
        lastCheckedAt={lastCheckedAt}
        isStale={isStale}
      />

      {/* Availability card with period tabs + actions */}
      <section
        className="rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
        aria-label="Availability"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-gray-900">Availability</h2>
          <div className="flex flex-wrap items-center gap-2">
            <PeriodTabs value={period} onChange={setPeriod} />
            <div className="ml-2 h-5 w-px bg-gray-200" aria-hidden="true" />
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
            >
              <ExternalIcon />
              {publicStatusHref ? (
                <a href={publicStatusHref} target="_blank" rel="noopener">
                  Public status page
                </a>
              ) : (
                <span>Public status page</span>
              )}
            </button>
            <CopyLinkButton href={publicStatusHref ?? '#'} disabled={!publicStatusHref} />
          </div>
        </header>

        <div className="px-5 py-5">
          <AvailabilityTimeline events={events} days={90} intervalMs={intervalS * 1000} />
          <p className="mt-3 text-xs text-gray-500">
            Hover a day for its downtime · times in UTC
          </p>
        </div>
      </section>

      {/* Stats row */}
      <StatsRow
        uptime24h={stats24h?.uptimePercent ?? null}
        uptime7d={stats?.uptimePercent ?? null}
        uptime30d={stats30d?.uptimePercent ?? null}
        checks24h={stats24h?.total ?? null}
        checks7d={stats?.total ?? null}
        checks30d={stats30d?.total ?? null}
        avgLatencyMs={stats?.avgLatencyMs ?? null}
      />

      {/* Downtime history */}
      <DowntimeHistory incidents={incidents} />

      {/* Monitor settings */}
      <MonitorSettingsSection
        monitorId={monitorId}
        intervalS={intervalS}
        initialFailuresBeforeAlert={initialFailuresBeforeAlert}
        initialAlertEmail={initialAlertEmail}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Small UI parts                                                              */
/* -------------------------------------------------------------------------- */

function PeriodTabs({
  value,
  onChange,
}: {
  value: '7d' | '30d'
  onChange: (next: '7d' | '30d') => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Availability period"
      className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 p-0.5"
    >
      {(['7d', '30d'] as const).map((option) => {
        const active = option === value
        return (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option)}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? 'border border-blue-200 bg-white text-blue-700 shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {option === '7d' ? '7 days' : '30 days'}
          </button>
        )
      })}
    </div>
  )
}

function MonitoringToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <label className="inline-flex items-center gap-2 text-xs text-gray-700">
      <span className="font-medium">Monitoring {on ? 'on' : 'off'}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          on ? 'bg-emerald-500' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            on ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  )
}

function CopyLinkButton({ href, disabled }: { href: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          void navigator.clipboard.writeText(href)
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <CopyIcon />
      Copy link
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Icons                                                                       */
/* -------------------------------------------------------------------------- */

function RefreshIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

function ExternalIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4h6v6" />
      <path d="M10 14 20 4" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  )
}

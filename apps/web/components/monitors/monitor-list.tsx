'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import anime from 'animejs'
import { capStagger, motionAllowed } from '@/components/console/motion.ts'
import { Icon } from '@/components/console/icons.tsx'
import { StatusDot } from './status-dot'
import { UptimeBadge } from './uptime-badge'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface MonitorItem {
  id: string
  type: 'uptime' | 'domain' | 'rescan' | string
  enabled: boolean
  lastStatus: 'up' | 'down' | 'stale' | 'disabled' | null
  lastRunAt: string | null
  intervalS: number
  projectUrl: string
  projectName: string
  isStale: boolean
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

function formatInterval(intervalS: number): string {
  if (intervalS >= 86400) return 'daily'
  if (intervalS < 60) return `every ${intervalS}s`
  return `every ${Math.round(intervalS / 60)}m`
}

function getStaleTooltip(lastRunAt: string | null, intervalS: number): string {
  if (!lastRunAt) return 'Never checked'
  const diff = Date.now() - new Date(lastRunAt).getTime()
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(minutes / 60)
  const expected = formatInterval(intervalS)
  return hours > 0
    ? `Last check ${hours}h ago (expected ${expected})`
    : `Last check ${minutes}m ago (expected ${expected})`
}

/**
 * The type badge that sits to the right of the project name.
 * Uses the same bordered-pill vocabulary as every other secondary label
 * in the console, rather than the hard-coded blue/purple colors it had before.
 */
function TypeBadge({ type, uptimePercent }: { type: string; uptimePercent: number | null }) {
  if (type === 'uptime') {
    return <UptimeBadge percent={uptimePercent} />
  }
  if (type === 'domain') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-c-line bg-c-soft px-2 py-0.5 text-[11px] font-medium text-c-muted">
        <Icon name="shield" size={11} />
        SSL &amp; Domain
      </span>
    )
  }
  if (type === 'rescan') {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-c-line bg-c-soft px-2 py-0.5 text-[11px] font-medium text-c-muted">
        <Icon name="search" size={11} />
        Daily re-scan
      </span>
    )
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* MonitorRow                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One row inside the monitor list card. Mirrors ProjectRow from the dashboard:
 * a link row with left icon, name stack, and right-aligned metadata.
 * Hairline top border on every row after the first — same as the Sites list.
 */
function MonitorRow({ monitor }: { monitor: MonitorItem }) {
  const [uptime, setUptime] = useState<number | null>(null)

  useEffect(() => {
    if (monitor.type !== 'uptime') return
    fetch(`/api/monitors/${monitor.id}/uptime?period=7d`)
      .then((r) => r.json())
      .then((d: { uptimePercent?: number }) => setUptime(d.uptimePercent ?? null))
      .catch(() => null)
  }, [monitor.id, monitor.type])

  // Disabled short-circuits everything else — a paused monitor must never
  // surface its frozen pre-pause lastStatus as the live reading.
  const displayStatus = !monitor.enabled
    ? 'disabled'
    : monitor.isStale
      ? 'stale'
      : monitor.lastStatus
  const tooltip = !monitor.enabled
    ? 'Monitoring is paused — no probes are being sent'
    : getStaleTooltip(monitor.lastRunAt, monitor.intervalS)

  return (
    <li
      data-row=""
      className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-c-line"
    >
      <Link
        href={`/monitors/${monitor.id}`}
        data-press=""
        className="flex items-center gap-4 px-6 py-4 transition-colors hover:bg-c-soft/60"
      >
        {/* Status indicator */}
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-c-line bg-c-soft">
          <StatusDot status={displayStatus} tooltip={tooltip} />
        </span>

        {/* Name + URL */}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-c-ink">
              {monitor.projectName}
            </span>
            {!monitor.enabled && <PausedBadge />}
          </span>
          <span className="block truncate font-mono text-[12px] text-c-muted">
            {monitor.projectUrl}
          </span>
        </span>

        {/* Metadata: type badge, last checked, interval */}
        <span className="flex shrink-0 items-center gap-3">
          <TypeBadge type={monitor.type} uptimePercent={uptime} />
          <span className="console-num hidden text-[12px] text-c-muted sm:block">
            {monitor.lastRunAt ? timeAgo(monitor.lastRunAt) : 'never'}
          </span>
          <span className="text-[12px] text-c-muted/60">
            {formatInterval(monitor.intervalS)}
          </span>
        </span>
      </Link>
    </li>
  )
}

/**
 * Paused — same hairline-pill vocabulary as the Soon and SSL badges, but in
 * the c-ink/c-muted tone that says "intentionally off" rather than
 * "not yet built" or "another category". Placed next to the project name so
 * the user notices the disabled state before anything else on the row.
 */
function PausedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-c-line bg-c-soft px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.06em] text-c-muted">
      Paused
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* MonitorList                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The full monitor list, fetched client-side and re-polled every 30 s.
 *
 * Rendered inside a card shell on the page (monitors/page.tsx). The list
 * itself is an <ul> with hairline-divided rows, matching the dashboard's
 * Sites list exactly.
 *
 * Motion: rows stagger in once on first load via the same capStagger/anime
 * contract as the rest of the console. Re-polls never re-animate — the
 * entered ref guards it.
 */
export function MonitorList() {
  const [monitors, setMonitors] = useState<MonitorItem[]>([])
  const [loading, setLoading] = useState(true)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const load = () =>
      fetch('/api/monitors')
        .then((r) => r.json())
        .then((d: { monitors?: MonitorItem[] }) => setMonitors(d.monitors ?? []))
        .finally(() => setLoading(false))

    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  /*
   * Stagger in once, when the first load lands. The list re-polls every 30 s;
   * re-animating on every poll would make the page lie about something changing
   * when nothing has. useLayoutEffect puts the hidden state and first animation
   * frame in the same paint — no flash of settled rows.
   */
  const entered = useRef(false)
  useLayoutEffect(() => {
    if (loading || entered.current || monitors.length === 0) return
    entered.current = true
    if (!motionAllowed()) return

    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-row]')
    if (!rows || rows.length === 0) return
    const step = capStagger(rows.length, 50, 300)
    const animation = anime({
      targets: rows,
      opacity: [0, 1],
      translateY: [8, 0],
      duration: 450,
      easing: 'easeOutExpo',
      delay: (_element: unknown, index: number) => index * step,
    })
    return () => animation.pause()
  }, [loading, monitors])

  if (loading) {
    return (
      <ul>
        {[...Array(3)].map((_, i) => (
          <li
            key={i}
            className={`flex items-center gap-4 px-6 py-4 ${i > 0 ? 'border-t border-c-line' : ''}`}
          >
            <span className="h-9 w-9 animate-pulse rounded-md bg-c-soft" />
            <span className="flex-1 space-y-2">
              <span className="block h-3.5 w-40 animate-pulse rounded bg-c-soft" />
              <span className="block h-3 w-24 animate-pulse rounded bg-c-soft" />
            </span>
            <span className="h-5 w-16 animate-pulse rounded-md bg-c-soft" />
          </li>
        ))}
      </ul>
    )
  }

  if (monitors.length === 0) {
    return (
      <p className="px-6 py-8 text-center text-sm text-c-muted">No monitors active.</p>
    )
  }

  return (
    <ul ref={listRef}>
      {monitors.map((m) => (
        <MonitorRow key={m.id} monitor={m} />
      ))}
    </ul>
  )
}
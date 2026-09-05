'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import anime from 'animejs'
import { capStagger, motionAllowed } from '@/components/console/motion.ts'
import { StatusDot } from './status-dot'
import { UptimeBadge } from './uptime-badge'

interface MonitorItem {
  id: string
  type: string
  enabled: boolean
  lastStatus: 'up' | 'down' | 'stale' | null
  lastRunAt: string | null
  intervalS: number
  projectUrl: string
  projectName: string
  isStale: boolean
}

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
  const lastRun = new Date(lastRunAt)
  const diff = Date.now() - lastRun.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const expectedInterval = formatInterval(intervalS)
  
  if (hours > 0) {
    return `Last check ${hours}h ago (expected ${expectedInterval})`
  }
  return `Last check ${minutes}m ago (expected ${expectedInterval})`
}

function MonitorRow({ monitor }: { monitor: MonitorItem }) {
  const [uptime, setUptime] = useState<number | null>(null)

  useEffect(() => {
    if (monitor.type === 'uptime') {
      fetch(`/api/monitors/${monitor.id}/uptime?period=7d`)
        .then((r) => r.json())
        .then((d) => setUptime(d.uptimePercent))
        .catch(() => null)
    }
  }, [monitor.id, monitor.type])

  const typeBadge = () => {
    if (monitor.type === 'uptime') {
      return <UptimeBadge percent={uptime} />
    }
    if (monitor.type === 'domain') {
      return (
        <span className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          SSL &amp; Domain
        </span>
      )
    }
    if (monitor.type === 'rescan') {
      return (
        <span className="rounded-md bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
          Daily Re-scan
        </span>
      )
    }
    return null
  }

  const displayStatus = monitor.isStale ? 'stale' : monitor.lastStatus
  const tooltip = getStaleTooltip(monitor.lastRunAt, monitor.intervalS)

  return (
    <Link
      href={`/monitors/${monitor.id}`}
      data-row=""
      data-press=""
      className="flex items-center gap-4 rounded-lg border border-c-line bg-c-card px-4 py-3 transition-colors hover:border-c-line/80 hover:bg-c-soft"
    >
      <StatusDot status={displayStatus} tooltip={tooltip} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-c-ink">{monitor.projectName}</p>
        <p className="font-mono text-xs text-c-muted">{monitor.projectUrl}</p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {typeBadge()}
        <span className="text-xs text-c-muted">
          {monitor.lastRunAt ? timeAgo(monitor.lastRunAt) : 'never'}
        </span>
        <span className="text-xs text-c-muted/70">{formatInterval(monitor.intervalS)}</span>
      </div>
    </Link>
  )
}

export function MonitorList() {
  const [monitors, setMonitors] = useState<MonitorItem[]>([])
  const [loading, setLoading] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const load = () =>
      fetch('/api/monitors')
        .then((r) => r.json())
        .then((d) => setMonitors(d.monitors ?? []))
        .finally(() => setLoading(false))

    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  /*
   * The rows stagger in once, when the FIRST load lands. The list re-polls
   * every 30s; re-animating on every poll would make the page lie about
   * something having changed when nothing has, so the entrance ref fires
   * exactly once. useLayoutEffect keeps the hidden state and the first
   * animation frame in the same paint, so there is no flash of settled rows.
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
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-c-soft" />
        ))}
      </div>
    )
  }

  if (monitors.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-c-line bg-c-card py-16 text-center">
        <p className="text-sm text-c-muted">No monitors yet.</p>
      </div>
    )
  }

  return (
    <div ref={listRef} className="space-y-2">
      {monitors.map((m) => (
        <MonitorRow key={m.id} monitor={m} />
      ))}
    </div>
  )
}
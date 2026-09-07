'use client'

import { useMemo, useState } from 'react'
import {
  formatDowntime,
  formatShortDate,
  summarize,
  toDays,
  type UptimeDay,
} from './uptime-days.ts'

/**
 * 90-day availability strip, checkvibe style.
 *
 * Three bar colours, one legend, one hover tooltip:
 *   - red    = any outage that day
 *   - green  = all checks passed
 *   - gray   = no checks recorded
 *
 * The hover tooltip is a controlled state instead of `title=` because a
 * title popup cannot be styled, and a styled popup is the only thing that
 * reads at a glance against a 90-bar strip — the bars are 4px wide and
 * the default browser popup lives for ~5s.
 *
 * Pure CSS, no chart library. Same reasoning as the public status strip:
 * one dependency-free render beats a 30kB chart for 90 thin bars.
 */

interface AvailabilityTimelineProps {
  /** Raw monitor events. */
  events: ReadonlyArray<{ ts: Date | string; ok: boolean }>
  /** Probe interval in ms — used for the downtime tooltip estimate. */
  intervalMs?: number
  /** How many days back to render. Defaults to 90. */
  days?: number
  /** Override the right-edge label (defaults to "Today"). */
  rightLabel?: string
}

export function AvailabilityTimeline({
  events,
  intervalMs = 60_000,
  days = 90,
  rightLabel = 'Today',
}: AvailabilityTimelineProps) {
  const dayList = useMemo(
    () => toDays(events, days, intervalMs),
    [events, days, intervalMs],
  )
  const summary = useMemo(() => summarize(dayList), [dayList])
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const leftDate = dayList[0]
  const rightDate = dayList[dayList.length - 1]
  const leftLabel = leftDate ? formatShortDate(leftDate.date) : ''

  return (
    <div>
      <div className="flex h-7 items-stretch gap-[3px]" aria-label="90-day availability">
        {dayList.map((day, idx) => (
          <Bar
            key={day.date}
            day={day}
            onHover={(hovering) => setHoverIdx(hovering ? idx : null)}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
        <span>{leftLabel}</span>
        <Legend
          outageCount={summary.outageCount}
          todayCount={summary.todayCount}
          noChecksCount={summary.noChecksCount}
        />
        <span>{rightLabel}</span>
      </div>

      <Tooltip day={hoverIdx !== null ? dayList[hoverIdx] ?? null : null} />
    </div>
  )
}

function Bar({
  day,
  onHover,
}: {
  day: UptimeDay
  onHover: (hovering: boolean) => void
}) {
  const color =
    day.state === 'down'
      ? '#ef4444' // red-500
      : day.state === 'ok'
        ? '#22c55e' // green-500
        : '#e5e7eb' // gray-200
  return (
    <button
      type="button"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      aria-label={`${formatShortDate(day.date)} — ${day.state}`}
      className="flex-1 cursor-default rounded-[2px] transition-opacity hover:opacity-80"
      style={{
        backgroundColor: color,
        minWidth: 3,
      }}
    />
  )
}

function Legend({
  outageCount,
  todayCount,
  noChecksCount,
}: {
  outageCount: number
  todayCount: number
  noChecksCount: number
}) {
  return (
    <div className="flex items-center gap-4">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 rounded-[2px]"
          style={{ backgroundColor: '#ef4444' }}
        />
        Outage <strong className="font-semibold tabular-nums text-gray-700">{outageCount}</strong>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 rounded-[2px]"
          style={{ backgroundColor: '#e9d5ff' }}
        />
        Today, still counting{' '}
        <strong className="font-semibold tabular-nums text-gray-700">{todayCount}</strong>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 rounded-[2px]"
          style={{ backgroundColor: '#e5e7eb' }}
        />
        No checks{' '}
        <strong className="font-semibold tabular-nums text-gray-700">{noChecksCount}</strong>
      </span>
    </div>
  )
}

function Tooltip({ day }: { day: UptimeDay | null }) {
  if (!day) return null
  const dateLabel = formatShortDate(day.date)
  if (day.state === 'down') {
    return (
      <p className="mt-2 text-xs text-gray-500" role="status">
        <strong className="font-medium text-gray-900">{dateLabel}</strong> — {day.failed} failed
        checks · downtime ≈ {formatDowntime(day.downMs)}
      </p>
    )
  }
  if (day.state === 'ok') {
    return (
      <p className="mt-2 text-xs text-gray-500" role="status">
        <strong className="font-medium text-gray-900">{dateLabel}</strong> —{' '}
        {day.ok} check{day.ok === 1 ? '' : 's'} passed
      </p>
    )
  }
  return (
    <p className="mt-2 text-xs text-gray-500" role="status">
      <strong className="font-medium text-gray-900">{dateLabel}</strong> — no checks recorded
    </p>
  )
}

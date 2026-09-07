/**
 * Grouping uptime events into days, with the THREE states the checkvibe
 * timeline needs:
 *   - `empty`  — no checks recorded that day
 *   - `ok`     — every recorded check that day was up
 *   - `down`   — at least one recorded check that day was down
 *
 * Kept out of the component so it can be tested without a JSX transform — and
 * because it is the only part of the status page with logic worth testing. A
 * strip that renders the wrong day is a status page that misleads during
 * exactly the incident it was linked for.
 */

export type DayState = 'empty' | 'ok' | 'down'

export interface UptimeDay {
  date: string
  state: DayState
  ok: number
  failed: number
  /** Approximate downtime duration in milliseconds (sum of failed checks ×
   *  assumed interval). Best-effort — only meaningful when state = 'down'. */
  downMs: number
}

/**
 * Grouped by UTC day so the strip reads the same from every time zone.
 *
 * Returns EXACTLY `days` entries, oldest first. The last entry is always
 * the current day (which gets the `today` flag handled by the caller), and
 * any day with no events is filled with an `empty` slot rather than dropped.
 *
 * `assumedIntervalMs` is used to convert failed-check counts into a downtime
 * estimate. Defaults to 60s — the standard uptime probe interval.
 */
export function toDays(
  events: ReadonlyArray<{ ts: Date | string; ok: boolean }>,
  days = 90,
  assumedIntervalMs = 60_000,
): UptimeDay[] {
  const byDay = new Map<string, { ok: number; failed: number }>()

  for (const event of events) {
    const ts = typeof event.ts === 'string' ? new Date(event.ts) : event.ts
    const date = ts.toISOString().slice(0, 10)
    const bucket = byDay.get(date) ?? { ok: 0, failed: 0 }
    if (event.ok) bucket.ok += 1
    else bucket.failed += 1
    byDay.set(date, bucket)
  }

  // Build the FULL window so empty days stay visible.
  const window: UptimeDay[] = []
  const todayUtc = new Date().toISOString().slice(0, 10)
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    const date = d.toISOString().slice(0, 10)
    const bucket = byDay.get(date)
    if (!bucket) {
      window.push({
        date,
        state: date === todayUtc ? 'empty' : 'empty',
        ok: 0,
        failed: 0,
        downMs: 0,
      })
    } else {
      const state: DayState = bucket.failed > 0 ? 'down' : 'ok'
      window.push({
        date,
        state,
        ok: bucket.ok,
        failed: bucket.failed,
        downMs: bucket.failed * assumedIntervalMs,
      })
    }
  }

  return window
}

/**
 * Aggregate counts for the legend: how many of the 90 days were outage days,
 * how many are "today" (still being recorded), how many had no checks at all.
 */
export function summarize(days: ReadonlyArray<UptimeDay>): {
  outageCount: number
  todayCount: number
  noChecksCount: number
} {
  let outageCount = 0
  let todayCount = 0
  let noChecksCount = 0
  const todayUtc = new Date().toISOString().slice(0, 10)

  for (let i = 0; i < days.length; i += 1) {
    const day = days[i]
    if (!day) continue
    if (day.state === 'down') outageCount += 1
    if (day.date === todayUtc) todayCount += 1
    if (day.ok === 0 && day.failed === 0) noChecksCount += 1
  }

  return { outageCount, todayCount, noChecksCount }
}

/**
 * Format a duration in ms as `Xh Ym` / `Ym Zs` / `Zs`. Used in the tooltip
 * on hover over a downtime bar.
 */
export function formatDowntime(ms: number): string {
  if (ms <= 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Format a date like `Sep 6` for the legend labels.
 */
export function formatShortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

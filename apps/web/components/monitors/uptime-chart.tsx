'use client' /* uptime error — was missing 'use client' directive, required for client-side rendering */

/**
 * Ninety days of uptime as a strip of bars, oldest on the left.
 *
 * No chart library. This is a flex row of divs with a title attribute, and a
 * dependency for it would ship more JavaScript than the whole page renders.
 */

import { toDays } from './uptime-days.ts'

export function UptimeChart({ events }: { events: ReadonlyArray<{ ts: Date | string; ok: boolean }> }) {
  const days = toDays(events)

  if (days.length === 0) {
    return <p className="text-sm text-muted">No checks recorded yet.</p>
  }

  const totalOk = days.reduce((sum, day) => sum + day.ok, 0)
  const totalFailed = days.reduce((sum, day) => sum + day.failed, 0)
  const uptime = totalOk + totalFailed === 0 ? 100 : (totalOk / (totalOk + totalFailed)) * 100

  return (
    <div>
      {/* data-motion="bars" lets the landing page's motion island grow the
          strip in when it is reached; inert wherever no island is mounted
          (the console and the status pages render it plain). */}
      <div data-motion="bars" className="flex h-10 items-stretch gap-[2px]" aria-hidden="true">
        {days.map((day) => (
          <div
            key={day.date}
            title={`${day.date} · ${day.ok} ok, ${day.failed} failed`}
            className="min-w-[3px] flex-1"
            style={{ backgroundColor: day.failed > 0 ? 'var(--critical)' : 'var(--good)' }}
          />
        ))}
      </div>
      <p className="mt-2 text-sm text-muted tabular-nums">
        {uptime.toFixed(2)}% over {days.length} day{days.length === 1 ? '' : 's'}
        {totalFailed > 0 && ` · ${totalFailed} failed check${totalFailed === 1 ? '' : 's'}`}
      </p>
    </div>
  )
}

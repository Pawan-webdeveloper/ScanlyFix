'use client'

/**
 * The hero block at the top of the uptime page.
 *
 * Three states:
 *   down   — red pulsing dot, "Down", down-since timestamp
 *   up     — green dot, "Up", operational text
 *   null   — grey dot, "No recent checks" — shown when monitor is stale
 *            (Inngest worker not running) or has never been probed.
 *            Previously this fell back to "Up" which was a lie.
 */

interface StatusHeroProps {
  status: 'up' | 'down' | null
  /** When the current down-state started (null when never / currently up). */
  stateStartedAt: string | null
  /** Last probe timestamp. */
  lastCheckedAt: string | null
  /** True when the worker hasn't checked in for 3× the monitor interval. */
  isStale?: boolean
}

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return FORMATTER.format(d).replace(' UTC', ' UTC')
}

export function StatusHero({
  status,
  stateStartedAt,
  lastCheckedAt,
  isStale = false,
}: StatusHeroProps) {
  // Stale or never-run: we don't know the real state.
  const unknown = status === null || isStale

  const label = unknown ? 'No recent checks' : status === 'down' ? 'Down' : 'Up'
  const color = unknown ? '#9ca3af' : status === 'down' ? '#ef4444' : '#22c55e'

  let sub: string
  if (unknown) {
    sub = lastCheckedAt
      ? `Last checked ${fmt(lastCheckedAt)} — monitoring may be paused`
      : 'This monitor has not run yet'
  } else if (status === 'down') {
    sub = `Down since ${fmt(stateStartedAt)} · last checked ${fmt(lastCheckedAt)}`
  } else {
    sub = `Operational · last checked ${fmt(lastCheckedAt)}`
  }

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
      aria-label={`Status: ${label}`}
    >
      <div className="flex items-start gap-3">
        <span className="relative mt-1 grid h-4 w-4 shrink-0 place-items-center" aria-hidden="true">
          {/* Pulsing ring only when actually down — not stale, not up */}
          {status === 'down' && !isStale && (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{ backgroundColor: color }}
            />
          )}
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
        </span>
        <div className="min-w-0">
          <h2
            className="text-[32px] font-bold leading-none tracking-tight"
            style={{ color }}
          >
            {label}
          </h2>
          <p className="mt-2 text-sm text-gray-600">{sub}</p>
        </div>
      </div>
    </section>
  )
}

'use client'

/**
 * Four stat cards across the row:
 *   LAST 24 HOURS · LAST 7 DAYS · LAST 30 DAYS · ANSWER SPEED
 *
 * Each card has the same anatomy:
 *   - uppercase label, 11px, letter-spaced
 *   - large bold value (28px)
 *   - sub-label with check count or "No data yet"
 *
 * The value uses red when the uptime is below 99% and green otherwise; the
 * answer-speed card shows a dash + "No data yet" until the monitor has
 * recorded enough successful probes for a meaningful average.
 */

interface StatsRowProps {
  uptime24h: number | null
  uptime7d: number | null
  uptime30d: number | null
  checks24h: number | null
  checks7d: number | null
  checks30d: number | null
  /** Average successful response time in ms (null = no data). */
  avgLatencyMs: number | null
}

export function StatsRow({
  uptime24h,
  uptime7d,
  uptime30d,
  checks24h,
  checks7d,
  checks30d,
  avgLatencyMs,
}: StatsRowProps) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat
        label="Last 24 hours"
        percent={uptime24h}
        checks={checks24h}
      />
      <Stat
        label="Last 7 days"
        percent={uptime7d}
        checks={checks7d}
      />
      <Stat
        label="Last 30 days"
        percent={uptime30d}
        checks={checks30d}
      />
      <LatencyCard avgLatencyMs={avgLatencyMs} />
    </div>
  )
}

function Stat({
  label,
  percent,
  checks,
}: {
  label: string
  percent: number | null
  checks: number | null
}) {
  const display = percent === null ? '—' : `${percent.toFixed(2)}%`
  const isDown = percent !== null && percent < 99
  const color = percent === null
    ? '#9ca3af'
    : isDown
      ? '#ef4444'
      : '#22c55e'

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
        {label}
      </p>
      <p
        className="mt-3 text-[28px] font-bold leading-none tracking-tight tabular-nums"
        style={{ color }}
      >
        {display}
      </p>
      <p className="mt-2 text-xs text-gray-500">
        {checks === null
          ? 'No data yet'
          : `${checks} check${checks === 1 ? '' : 's'}`}
      </p>
    </div>
  )
}

function LatencyCard({ avgLatencyMs }: { avgLatencyMs: number | null }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
        Answer speed
      </p>
      <p
        className="mt-3 text-[28px] font-bold leading-none tracking-tight text-gray-900"
        aria-label={avgLatencyMs === null ? 'No answer speed data yet' : `${avgLatencyMs} milliseconds`}
      >
        {avgLatencyMs === null ? (
          <span aria-hidden="true">—</span>
        ) : (
          `${avgLatencyMs}ms`
        )}
      </p>
      <p className="mt-2 text-xs text-gray-500">
        {avgLatencyMs === null ? 'No data yet' : 'Average successful probe'}
      </p>
    </div>
  )
}

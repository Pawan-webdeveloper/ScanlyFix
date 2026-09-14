'use client'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ResponseTimeDataPoint {
  timestamp: string
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  maxLatencyMs: number | null
  totalChecks: number
}

interface ResponseTimeChartProps {
  data: ResponseTimeDataPoint[]
  range: '1h' | '24h' | '7d'
  p95LatencyMs?: number | null
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function barColor(avgLatencyMs: number | null, totalChecks: number): string {
  if (totalChecks === 0 || avgLatencyMs === null) return 'bg-c-line'
  if (avgLatencyMs < 200) return 'bg-emerald-400'
  if (avgLatencyMs < 500) return 'bg-yellow-400'
  return 'bg-orange-400'
}

function formatLabel(timestamp: string, range: '1h' | '24h' | '7d'): string {
  const date = new Date(timestamp)

  switch (range) {
    case '1h':
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    case '24h':
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    case '7d':
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
}

function formatTooltip(
  point: ResponseTimeDataPoint,
  range: '1h' | '24h' | '7d',
): string {
  const date = new Date(point.timestamp)
  const timeStr =
    range === '7d'
      ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (point.avgLatencyMs === null) {
    return `${timeStr} · No data`
  }

  return `${timeStr} · avg ${point.avgLatencyMs}ms · p95 ${point.p95LatencyMs ?? '—'}ms`
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ResponseTimeChart({ data, range, p95LatencyMs }: ResponseTimeChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded-lg bg-c-soft text-xs text-c-muted/70">
        No data yet
      </div>
    )
  }

  // Calculate max for scaling
  const maxLatency = Math.max(
    ...data.map((d) => d.maxLatencyMs ?? d.avgLatencyMs ?? 0),
    1,
  )

  // p95 reference line position
  const p95HeightPct =
    p95LatencyMs ? Math.min((p95LatencyMs / maxLatency) * 100, 100) : null

  // Determine how many x-axis labels to show (max ~6)
  const labelInterval = Math.max(Math.ceil(data.length / 6), 1)

  return (
    <div className="space-y-2">
      {/* Chart */}
      <div className="relative flex h-24 items-end gap-px">
        {/* p95 reference line */}
        {p95HeightPct !== null && p95HeightPct > 0 && p95HeightPct <= 100 && (
          <div
            className="absolute left-0 right-0 border-t border-dashed border-purple-400"
            style={{ bottom: `${p95HeightPct}%` }}
          />
        )}

        {/* Bars */}
        {data.map((point, i) => {
          const latency = point.avgLatencyMs ?? 0
          const heightPct = Math.max((latency / maxLatency) * 100, 2)
          const color = barColor(point.avgLatencyMs, point.totalChecks)
          const label = formatLabel(point.timestamp, range)
          const tooltip = formatTooltip(point, range)

          return (
            <div
              key={i}
              className="group relative flex-1"
              style={{ height: '100%', display: 'flex', alignItems: 'flex-end' }}
            >
              <div
                className={`w-full rounded-sm ${color} transition-opacity group-hover:opacity-80`}
                style={{ height: `${heightPct}%` }}
              />
              {/* Tooltip */}
              <div className="pointer-events-none absolute bottom-full left-1/2 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded bg-c-ink px-2 py-1 text-xs text-c-brand-ink group-hover:block z-10">
                {tooltip}
              </div>
            </div>
          )
        })}
      </div>

      {/* X-axis labels */}
      <div className="flex justify-between text-xs text-c-muted/70">
        <span>
          {maxLatency}ms max
          {p95LatencyMs != null && (
            <span className="ml-2 text-purple-500">· p95 {p95LatencyMs}ms</span>
          )}
        </span>
        <div className="flex gap-2">
          {data
            .filter((_, i) => i % labelInterval === 0 || i === data.length - 1)
            .map((point, i) => (
              <span key={i} className="text-c-muted/70">
                {formatLabel(point.timestamp, range)}
              </span>
            ))}
        </div>
      </div>
    </div>
  )
}

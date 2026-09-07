'use client'

export type MonitorStatus = 'up' | 'down' | 'stale' | 'disabled' | null

interface StatusDotProps {
  status: MonitorStatus
  size?: 'sm' | 'md'
  tooltip?: string
}

export function StatusDot({ status, size = 'md', tooltip }: StatusDotProps) {
  const sz = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5'

  if (status === 'up') {
    return (
      <span className="relative flex shrink-0" title={tooltip}>
        <span className={`${sz} rounded-full bg-emerald-500`} />
      </span>
    )
  }

  if (status === 'down') {
    return (
      <span className="relative flex shrink-0" title={tooltip}>
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75`}
        />
        <span className={`${sz} rounded-full bg-red-500`} />
      </span>
    )
  }

  if (status === 'stale') {
    // Stale: checked once but overdue — muted dot with a quiet amber ring
    return (
      <span className="relative flex shrink-0" title={tooltip}>
        <span
          className={`${sz} rounded-full bg-c-muted/50 ring-2 ring-amber-400/40 dark:ring-amber-400/30`}
        />
      </span>
    )
  }

  if (status === 'disabled') {
    // Paused — a hollow hairline ring so it reads as "intentionally off"
    // rather than as a missing probe result. No fill, no pulse.
    return (
      <span className="relative flex shrink-0" title={tooltip}>
        <span
          className={`${sz} rounded-full border border-c-line bg-transparent`}
        />
      </span>
    )
  }

  // null = never run yet — use the hairline colour so it reads as "absent"
  return (
    <span className="relative flex shrink-0" title={tooltip}>
      <span className={`${sz} rounded-full bg-c-line`} />
    </span>
  )
}
'use client'

interface UptimeBadgeProps {
  percent: number | null
}

/**
 * 7-day uptime percentage badge, styled to the console design system.
 *
 * Colour vocabulary mirrors the severity/score palette already in globals.css:
 * emerald for healthy, amber for degraded, the high-severity red for poor.
 * Dark mode variants are explicit so the badge reads on both canvas colours.
 */
export function UptimeBadge({ percent }: UptimeBadgeProps) {
  if (percent === null) {
    return (
      <span className="inline-flex items-center rounded-md border border-c-line bg-c-soft px-2 py-0.5 text-[11px] font-medium text-c-muted">
        No data
      </span>
    )
  }

  const formatted = percent.toFixed(2) + '%'

  const color =
    percent >= 99.9
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : percent >= 99
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : 'bg-sev-high/10 text-sev-high'

  return (
    <span
      className={`console-num inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums ${color}`}
    >
      {formatted}
    </span>
  )
}
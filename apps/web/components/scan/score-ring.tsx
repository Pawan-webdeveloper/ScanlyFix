/**
 * The number people screenshot.
 *
 * A server component: an SVG arc has no state, so shipping JavaScript for it
 * would be paying for nothing. The colour bands (90 / 70) are the same ones the
 * CLI uses, so a score never looks healthy in one surface and poor in the other.
 *
 * The data-draw / data-count attributes are motion hooks for the console's
 * PageMotion island (components/console/motion.tsx): where the ring renders
 * inside a motion scope the arc sweeps in and the number counts up; on the
 * shareable report page, which mounts no island, they are inert markup.
 */

const BANDS = [
  { min: 90, token: 'var(--good)' },
  { min: 70, token: 'var(--medium)' },
  { min: 0, token: 'var(--critical)' },
] as const

export function scoreColor(score: number): string {
  return (BANDS.find((b) => score >= b.min) ?? BANDS[2]).token
}

export function ScoreRing({ score, size = 168 }: { score: number; size?: number }) {
  const stroke = Math.round(size * 0.075)
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  // Clamped so a malformed stored score can never draw an arc longer than the
  // circle or a negative dash offset.
  const filled = (Math.min(100, Math.max(0, score)) / 100) * circumference

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Overall score ${score} out of 100`}
      className="shrink-0"
    >
      {/* Rotated so the arc starts at twelve o'clock rather than three. */}
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        <circle
          data-draw=""
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={scoreColor(score)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
        />
      </g>
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        data-count={String(score)}
        className="font-semibold tabular-nums"
        fontSize={size * 0.3}
        fill="var(--ink)"
      >
        {score}
      </text>
    </svg>
  )
}

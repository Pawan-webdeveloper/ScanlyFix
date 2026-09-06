"use client"

/**
 * The dashboard's score profile: the six pillar scores of the latest scan as
 * one shape, where dips read as weaknesses at a glance — the donut the ring
 * used to draw could only say "one number", never "which pillar is caving in".
 * The precise numbers stay in the PillarScores list beside it, which is also
 * where a provisional (degraded) pillar says so; the radar plots the same
 * real scores and invents nothing.
 *
 * A client island of necessity — recharts measures its container and draws on
 * canvas events — so it is kept to this one card. Data arrives pre-shaped from
 * the server (see score-radar-data.ts); this component only renders it.
 */

import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from 'recharts'
import {
  Chart,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/radar-chart.tsx'
import { scoreColor } from './score-ring.tsx'
import type { RadarAxis } from './score-radar-data.ts'

const chartConfig = {
  score: {
    label: 'Score',
    // The console's one chromatic colour — a score meter is exactly what it
    // is reserved for (see globals.css). Themed, so dark mode follows along.
    color: 'var(--c-accent)',
  },
} satisfies ChartConfig

export function ScoreRadar({ data, overall }: { data: RadarAxis[]; overall: number }) {
  return (
    <figure className="flex flex-col items-center gap-1">
      <Chart config={chartConfig} className="mx-auto aspect-square w-full max-w-[320px]">
        <RadarChart data={data} margin={{ top: 12, right: 24, bottom: 12, left: 24 }} outerRadius="85%">
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          <PolarAngleAxis
            dataKey="label"
            tickLine={false}
            tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
          />
          <PolarGrid />
          {/* Fixed 0–100 radius: the polygon reads as a percentage of perfect,
              not as relative height against the scan's own worst pillar. */}
          <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
          <Radar
            dataKey="score"
            stroke="var(--c-accent)"
            fill="var(--color-score)"
            fillOpacity={0.3}
            strokeWidth={2}
          />
        </RadarChart>
      </Chart>
      <figcaption className="mt-1 text-[13px] text-c-muted">
        Overall{' '}
        <span
          className="console-num text-lg font-semibold tabular-nums"
          style={{ color: scoreColor(overall) }}
        >
          {overall}
        </span>{' '}
        / 100
      </figcaption>
    </figure>
  )
}

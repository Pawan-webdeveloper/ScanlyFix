/**
 * The axes of the dashboard's score radar.
 *
 * The radar is only honest if its data is the scan itself: every covered
 * pillar present, each axis carrying that pillar's real score, the overall
 * number never promoted to an axis, and degraded pillars kept rather than
 * hidden. These rules are PillarScores' rules — the chart and the list sit
 * side by side, so they cannot disagree.
 */

import { describe, expect, it } from 'vitest'
import { radarScoreData } from '@/components/scan/score-radar-data.ts'
import type { ScanScores } from '@scanlyfix/checks'

const PILLARS = [
  'security',
  'seo',
  'aeo',
  'performance',
  'accessibility',
  'compliance',
] as const

const scores: ScanScores = {
  security: 100,
  seo: 83,
  aeo: 0,
  performance: 67,
  accessibility: 100,
  compliance: 45,
  overall: 71,
  degraded: ['performance'],
}

describe('radarScoreData', () => {
  it('plots every covered pillar with its own real score — the shape is the scan', () => {
    const data = radarScoreData(scores)
    expect(data).toHaveLength(PILLARS.length)
    expect(new Set(data.map((axis) => axis.pillar))).toEqual(new Set(PILLARS))
    for (const axis of data) {
      expect(axis.score, axis.pillar).toBe(scores[axis.pillar])
    }
  })

  it('labels axes for a reader, not for the database', () => {
    const labels = new Set(radarScoreData(scores).map((axis) => axis.label))
    expect(labels).toEqual(
      new Set(['Security', 'SEO', 'AI answers', 'Performance', 'Accessibility', 'Compliance']),
    )
  })

  it('never plots the overall score as an axis', () => {
    // The overall is the shape's summary in the caption; an axis for it would
    // invent a seventh pillar the registry does not have.
    const data = radarScoreData(scores)
    expect(data.some((axis) => (axis.pillar as string) === 'overall')).toBe(false)
    expect(data.some((axis) => axis.label.toLowerCase() === 'overall')).toBe(false)
  })

  it('keeps a degraded pillar on the chart — provisional, not hidden', () => {
    // performance is degraded in the fixture; the radar still plots its best
    // available reading, exactly like the pillar list beside it does.
    const degraded = radarScoreData(scores).find((axis) => axis.pillar === 'performance')
    expect(degraded?.score).toBe(67)
  })

  it('reflects a different scan immediately — nothing is cached or sampled', () => {
    const second: ScanScores = { ...scores, security: 40, seo: 91, overall: 64 }
    const data = radarScoreData(second)
    expect(data.find((axis) => axis.pillar === 'security')?.score).toBe(40)
    expect(data.find((axis) => axis.pillar === 'seo')?.score).toBe(91)
  })
})

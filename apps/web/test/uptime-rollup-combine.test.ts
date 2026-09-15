import { describe, expect, it } from 'vitest'

import { combine, tailStartAfter } from '../../../packages/db/src/queries/rollups.ts'

/**
 * The arithmetic behind the uptime percentage.
 *
 * Rollups are written by a cron, so the figure on the page is always a rollup
 * plus whatever the cron has not reached yet. Getting the seam wrong is
 * invisible in review and very visible to a customer: one bucket too early and
 * every check in it is counted twice, one too late and they vanish.
 */

const HOUR = 3_600_000
const DAY = 86_400_000
const at = (iso: string) => new Date(iso)

describe('tailStartAfter', () => {
  it('reads raw events for the whole window when no rollup exists', () => {
    // A monitor enabled this morning has no daily rollup at all. Before this
    // existed it reported `total: 0` and the page showed a dash for a day.
    const start = at('2026-09-08T00:00:00Z')
    expect(tailStartAfter(null, DAY, start)).toEqual(start)
  })

  it('starts the tail at the bucket after the last one covered', () => {
    const covered = at('2026-09-14T00:00:00Z')
    expect(tailStartAfter(covered, DAY, at('2026-09-08T00:00:00Z'))).toEqual(at('2026-09-15T00:00:00Z'))
  })

  it('never reaches back before the window the caller asked for', () => {
    // A rollup older than the window must not widen it.
    const covered = at('2026-08-01T00:00:00Z')
    const start = at('2026-09-08T00:00:00Z')
    expect(tailStartAfter(covered, DAY, start)).toEqual(start)
  })

  it('advances by one hour for the hourly table', () => {
    const covered = at('2026-09-15T09:00:00Z')
    expect(tailStartAfter(covered, HOUR, at('2026-09-14T10:00:00Z'))).toEqual(at('2026-09-15T10:00:00Z'))
  })
})

describe('combine', () => {
  const rollup = { total: 100, up: 99, avgLatencyMs: 50, p95LatencyMs: 90 }

  it('adds the tail to the rollup', () => {
    const r = combine(rollup, { total: 4, up: 3, avgLatencyMs: 180, maxLatencyMs: 300 })
    expect(r.total).toBe(104)
    expect(r.up).toBe(102)
    expect(r.down).toBe(2)
    expect(r.uptimePercent).toBe(98.08)
  })

  it('weights the average by check count rather than averaging two averages', () => {
    // (50×100 + 180×4) / 104 = 55. Averaging the averages would give 115 — more
    // than double, from four checks out of a hundred and four.
    const r = combine(rollup, { total: 4, up: 4, avgLatencyMs: 180, maxLatencyMs: 300 })
    expect(r.avgLatencyMs).toBe(55)
  })

  it('reports unknown rather than a perfect score when nothing was recorded', () => {
    // 0% and "we have not checked yet" are different sentences, and a status
    // page that confuses them is worse than one that says nothing.
    const r = combine({ total: 0, up: 0, avgLatencyMs: null, p95LatencyMs: null }, { total: 0, up: 0, avgLatencyMs: null, maxLatencyMs: null })
    expect(r.uptimePercent).toBeNull()
    expect(r.avgLatencyMs).toBeNull()
    expect(r.p95LatencyMs).toBeNull()
  })

  it('works from the raw tail alone', () => {
    const r = combine({ total: 0, up: 0, avgLatencyMs: null, p95LatencyMs: null }, { total: 4, up: 3, avgLatencyMs: 180, maxLatencyMs: 300 })
    expect(r.uptimePercent).toBe(75)
    expect(r.avgLatencyMs).toBe(180)
  })

  it('takes the higher p95, because a rollup p95 cannot be merged with raw rows', () => {
    expect(combine(rollup, { total: 4, up: 4, avgLatencyMs: 10, maxLatencyMs: 300 }).p95LatencyMs).toBe(300)
    expect(combine(rollup, { total: 4, up: 4, avgLatencyMs: 10, maxLatencyMs: 20 }).p95LatencyMs).toBe(90)
  })

  it('rounds the percentage to two places without drifting', () => {
    expect(combine({ total: 3, up: 2, avgLatencyMs: null, p95LatencyMs: null }, { total: 0, up: 0, avgLatencyMs: null, maxLatencyMs: null }).uptimePercent).toBe(66.67)
    expect(combine({ total: 10_000, up: 9_999, avgLatencyMs: null, p95LatencyMs: null }, { total: 0, up: 0, avgLatencyMs: null, maxLatencyMs: null }).uptimePercent).toBe(99.99)
  })
})

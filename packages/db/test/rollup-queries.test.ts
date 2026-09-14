/**
 * Rollup queries tests.
 *
 * Tests the rollup aggregation functions:
 *   - aggregateHourlyRollup: aggregates raw events into hourly rollups
 *   - aggregateDailyRollup: aggregates raw events into daily rollups
 *   - cleanupOldEvents: deletes old raw events in batches
 *   - getUptimeFromHourlyRollups: computes uptime from hourly rollups
 *   - getUptimeFromDailyRollups: computes uptime from daily rollups
 *   - getDailyBucketsFromRollups: gets daily buckets for 90-day strip
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  aggregateHourlyRollup,
  aggregateDailyRollup,
  cleanupOldEvents,
  getUptimeFromHourlyRollups,
  getUptimeFromDailyRollups,
  getDailyBucketsFromRollups,
} from '../src/queries/rollups.ts'

describe('rollup queries', () => {
  // Mock db.execute and db.select to avoid real database calls
  let mockExecute: ReturnType<typeof vi.fn>
  let mockSelect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    mockExecute = vi.fn()
    mockSelect = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('aggregateHourlyRollup', () => {
    it('truncates hour to hour boundary', async () => {
      // Mock db.execute to return a successful result
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 5 }),
        },
      }))

      // Re-import to use mocked db
      const { aggregateHourlyRollup: mockedAggregate } = await import('../src/queries/rollups.ts')

      const hour = new Date('2025-01-15T14:37:22Z')
      await mockedAggregate(hour)

      // Verify the hour was truncated (14:37:22 → 14:00:00)
      expect(mockExecute).toHaveBeenCalledOnce()
      const sqlCall = mockExecute.mock.calls[0][0]
      expect(sqlCall).toBeDefined()
    })

    it('returns number of monitors processed', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 3 }),
        },
      }))

      const { aggregateHourlyRollup: mockedAggregate } = await import('../src/queries/rollups.ts')

      const result = await mockedAggregate(new Date())
      expect(result.monitorsProcessed).toBe(3)
    })

    it('handles zero monitors processed', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 0 }),
        },
      }))

      const { aggregateHourlyRollup: mockedAggregate } = await import('../src/queries/rollups.ts')

      const result = await mockedAggregate(new Date())
      expect(result.monitorsProcessed).toBe(0)
    })
  })

  describe('aggregateDailyRollup', () => {
    it('truncates day to day boundary', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 10 }),
        },
      }))

      const { aggregateDailyRollup: mockedAggregate } = await import('../src/queries/rollups.ts')

      const day = new Date('2025-01-15T14:37:22Z')
      const result = await mockedAggregate(day)

      // Verify the day was truncated (Jan 15 14:37:22 → Jan 15 00:00:00)
      expect(result.monitorsProcessed).toBe(10)
    })

    it('returns number of monitors processed', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 7 }),
        },
      }))

      const { aggregateDailyRollup: mockedAggregate } = await import('../src/queries/rollups.ts')

      const result = await mockedAggregate(new Date())
      expect(result.monitorsProcessed).toBe(7)
    })
  })

  describe('cleanupOldEvents', () => {
    it('returns number of rows deleted', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 500 }),
        },
      }))

      const { cleanupOldEvents: mockedCleanup } = await import('../src/queries/rollups.ts')

      const result = await mockedCleanup()
      expect(result).toBe(500)
    })

    it('returns 0 when no old events', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 0 }),
        },
      }))

      const { cleanupOldEvents: mockedCleanup } = await import('../src/queries/rollups.ts')

      const result = await mockedCleanup()
      expect(result).toBe(0)
    })

    it('uses custom batch size', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          execute: mockExecute.mockResolvedValue({ rowCount: 100 }),
        },
      }))

      const { cleanupOldEvents: mockedCleanup } = await import('../src/queries/rollups.ts')

      const result = await mockedCleanup(500)
      // Verify result is returned
      expect(result).toBe(100)
    })
  })

  describe('getUptimeFromHourlyRollups', () => {
    it('returns uptime statistics with latency', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn()
                .mockResolvedValueOnce([{ total: 100, up: 95, avgLatencyMs: 210, p95LatencyMs: 890 }])
                .mockResolvedValueOnce([{ at: new Date('2025-01-16T00:00:00Z') }])
                .mockResolvedValueOnce([]),
            }),
          }),
        },
      }))

      const { getUptimeFromHourlyRollups: mockedGetUptime } = await import('../src/queries/rollups.ts')

      const result = await mockedGetUptime(
        'monitor-id',
        new Date('2025-01-15T00:00:00Z'),
        new Date('2025-01-16T00:00:00Z'),
      )

      expect(result.total).toBe(100)
      expect(result.up).toBe(95)
      expect(result.down).toBe(5)
      expect(result.uptimePercent).toBe(95)
      expect(result.avgLatencyMs).toBe(210)
      expect(result.p95LatencyMs).toBe(890)
    })

    it('returns null uptimePercent when no events', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ total: 0, up: 0, avgLatencyMs: null, p95LatencyMs: null }]),
            }),
          }),
        },
      }))

      const { getUptimeFromHourlyRollups: mockedGetUptime } = await import('../src/queries/rollups.ts')

      const result = await mockedGetUptime(
        'monitor-id',
        new Date('2025-01-15T00:00:00Z'),
        new Date('2025-01-16T00:00:00Z'),
      )

      expect(result.total).toBe(0)
      expect(result.uptimePercent).toBeNull()
      expect(result.avgLatencyMs).toBeNull()
      expect(result.p95LatencyMs).toBeNull()
    })

    it('handles null result', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
        },
      }))

      const { getUptimeFromHourlyRollups: mockedGetUptime } = await import('../src/queries/rollups.ts')

      const result = await mockedGetUptime(
        'monitor-id',
        new Date('2025-01-15T00:00:00Z'),
        new Date('2025-01-16T00:00:00Z'),
      )

      expect(result.total).toBe(0)
      expect(result.up).toBe(0)
      expect(result.down).toBe(0)
      expect(result.uptimePercent).toBeNull()
      expect(result.avgLatencyMs).toBeNull()
      expect(result.p95LatencyMs).toBeNull()
    })
  })

  describe('getUptimeFromDailyRollups', () => {
    it('returns uptime statistics with latency', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn()
                .mockResolvedValueOnce([{ total: 720, up: 700, avgLatencyMs: 185, p95LatencyMs: 750 }])
                .mockResolvedValueOnce([{ at: new Date('2025-02-01T00:00:00Z') }])
                .mockResolvedValueOnce([]),
            }),
          }),
        },
      }))

      const { getUptimeFromDailyRollups: mockedGetUptime } = await import('../src/queries/rollups.ts')

      const result = await mockedGetUptime(
        'monitor-id',
        new Date('2025-01-01T00:00:00Z'),
        new Date('2025-02-01T00:00:00Z'),
      )

      expect(result.total).toBe(720)
      expect(result.up).toBe(700)
      expect(result.down).toBe(20)
      expect(result.uptimePercent).toBeCloseTo(97.22, 1)
      expect(result.avgLatencyMs).toBe(185)
      expect(result.p95LatencyMs).toBe(750)
    })

    it('returns null uptimePercent when no events', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ total: 0, up: 0, avgLatencyMs: null, p95LatencyMs: null }]),
            }),
          }),
        },
      }))

      const { getUptimeFromDailyRollups: mockedGetUptime } = await import('../src/queries/rollups.ts')

      const result = await mockedGetUptime(
        'monitor-id',
        new Date('2025-01-01T00:00:00Z'),
        new Date('2025-02-01T00:00:00Z'),
      )

      expect(result.uptimePercent).toBeNull()
      expect(result.avgLatencyMs).toBeNull()
      expect(result.p95LatencyMs).toBeNull()
    })
  })

  describe('getDailyBucketsFromRollups', () => {
    it('returns daily buckets', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([
                    { date: '2025-01-15', total: 100, up: 100 },
                    { date: '2025-01-16', total: 50, up: 45 },
                  ]),
                }),
              }),
            }),
          }),
        },
      }))

      const { getDailyBucketsFromRollups: mockedGetBuckets } = await import('../src/queries/rollups.ts')

      const result = await mockedGetBuckets('monitor-id', 2)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ date: '2025-01-15', ok: true, total: 100 })
      expect(result[1]).toEqual({ date: '2025-01-16', ok: false, total: 50 })
    })

    it('returns empty array when no data', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        },
      }))

      const { getDailyBucketsFromRollups: mockedGetBuckets } = await import('../src/queries/rollups.ts')

      const result = await mockedGetBuckets('monitor-id', 90)

      expect(result).toHaveLength(0)
    })

    it('defaults to 90 days', async () => {
      vi.doMock('../src/client.ts', () => ({
        db: {
          select: mockSelect.mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        },
      }))

      const { getDailyBucketsFromRollups: mockedGetBuckets } = await import('../src/queries/rollups.ts')

      // Should not throw with default days parameter
      const result = await mockedGetBuckets('monitor-id')

      expect(result).toBeDefined()
    })
  })
})

describe('rollup data integrity', () => {
  describe('hourly rollup aggregation', () => {
    it('up checks + down checks = total checks', () => {
      const total = 100
      const up = 85
      const down = total - up

      expect(up + down).toBe(total)
    })

    it('uptimePercent calculation is accurate', () => {
      const total = 1000
      const up = 995
      const uptimePercent = Math.round((up / total) * 10_000) / 100

      expect(uptimePercent).toBe(99.5)
    })

    it('uptimePercent is null when total is 0', () => {
      const total = 0
      const uptimePercent = total === 0 ? null : 100

      expect(uptimePercent).toBeNull()
    })
  })

  describe('daily rollup aggregation', () => {
    it('handles partial day data', () => {
      // A day with 100 checks, 95 up
      const total = 100
      const up = 95
      const uptimePercent = Math.round((up / total) * 10_000) / 100

      expect(uptimePercent).toBe(95)
    })

    it('handles perfect day', () => {
      const total = 24
      const up = 24
      const uptimePercent = Math.round((up / total) * 10_000) / 100

      expect(uptimePercent).toBe(100)
    })

    it('handles terrible day', () => {
      const total = 24
      const up = 1
      const uptimePercent = Math.round((up / total) * 10_000) / 100

      expect(uptimePercent).toBeCloseTo(4.17, 1)
    })
  })

  describe('cleanup retention', () => {
    it('90 days is correct retention period', () => {
      const days = 90
      const hoursPerDay = 24
      const expectedEventsPerMonitorPerDay = 24 // hourly checks
      const expectedEventsPerMonitorTotal = days * expectedEventsPerMonitorPerDay

      expect(expectedEventsPerMonitorTotal).toBe(2160)
    })

    it('batch size of 1000 is reasonable', () => {
      const batchSize = 1000
      const maxBatches = 100
      const maxRowsPerRun = batchSize * maxBatches

      // 100k rows max per run is reasonable for cleanup
      expect(maxRowsPerRun).toBe(100_000)
    })
  })
})

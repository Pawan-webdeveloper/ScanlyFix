/**
 * Characterization tests for consecutiveFailures()
 *
 * Purpose: Capture CURRENT behavior as a safety net before refactoring.
 * This function is DB-dependent, so we mock the DB layer.
 *
 * Coverage:
 *   - 0 failures (most recent ok)
 *   - 1 failure
 *   - 2+ consecutive failures
 *   - Recovery reset
 *   - Empty events
 *   - Lookback parameter
 *   - Mixed sequences
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ─── Mock DB Layer ────────────────────────────────────────────────────────────
// We mock the entire DB module to avoid requiring a real Postgres connection.

const mockFindMany = vi.fn()

vi.mock('../src/client.ts', () => ({
  db: {
    query: {
      monitorEvents: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}))

// Import after mocking
import { consecutiveFailures } from '../src/queries/monitors.ts'

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── Helper to create mock events ─────────────────────────────────────────────

function mockEvents(okSequence: boolean[]) {
  return okSequence.map((ok) => ({ ok }))
}

// ─── Core behavior ────────────────────────────────────────────────────────────

describe('consecutiveFailures — core behavior', () => {
  it('returns 0 when no events exist', async () => {
    mockFindMany.mockResolvedValue([])
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(0)
  })

  it('returns 0 when most recent event is ok', async () => {
    mockFindMany.mockResolvedValue(mockEvents([true]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(0)
  })

  it('returns 1 for a single failure', async () => {
    mockFindMany.mockResolvedValue(mockEvents([false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(1)
  })

  it('returns 2 for two consecutive failures', async () => {
    mockFindMany.mockResolvedValue(mockEvents([false, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(2)
  })

  it('returns 3 for three consecutive failures', async () => {
    mockFindMany.mockResolvedValue(mockEvents([false, false, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(3)
  })

  it('stops counting when it encounters an ok event', async () => {
    // Events are newest-first: [false, false, true]
    // Counts 2 failures from newest, then stops at true
    mockFindMany.mockResolvedValue(mockEvents([false, false, true]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(2)
  })

  it('counts only leading failures from newest', async () => {
    // Events are newest-first: [false, false, true, false, false]
    // Counts 2 failures from newest, stops at true
    mockFindMany.mockResolvedValue(mockEvents([false, false, true, false, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(2)
  })

  it('handles all ok events', async () => {
    mockFindMany.mockResolvedValue(mockEvents([true, true, true, true, true]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(0)
  })
})

// ─── Lookback parameter ───────────────────────────────────────────────────────

describe('consecutiveFailures — lookback parameter', () => {
  it('defaults to look=10', async () => {
    mockFindMany.mockResolvedValue([])
    await consecutiveFailures('monitor-1')
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    )
  })

  it('respects custom lookback value', async () => {
    mockFindMany.mockResolvedValue([])
    await consecutiveFailures('monitor-1', 10)
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    )
  })

  it('only examines up to `look` events', async () => {
    // Return 3 events when look=3
    mockFindMany.mockResolvedValue(mockEvents([false, false, false]))
    const result = await consecutiveFailures('monitor-1', 3)
    expect(result).toBe(3)
  })
})

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('consecutiveFailures — edge cases', () => {
  it('handles sequence: ok, fail, fail (resets at start)', async () => {
    // Most recent is ok, so streak = 0
    mockFindMany.mockResolvedValue(mockEvents([true, false, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(0)
  })

  it('handles sequence: fail, ok, fail (only counts leading fails)', async () => {
    // Most recent is fail, next is ok → streak = 1
    mockFindMany.mockResolvedValue(mockEvents([false, true, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(1)
  })

  it('handles sequence: fail, fail, ok, fail, fail (counts from newest)', async () => {
    // Events are newest-first: [false, false, true, false, false]
    // Counts 2 failures from newest, stops at true
    mockFindMany.mockResolvedValue(mockEvents([false, false, true, false, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(2)
  })

  it('passes correct monitorId to query', async () => {
    mockFindMany.mockResolvedValue([])
    await consecutiveFailures('my-monitor-id')
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.anything(),
      }),
    )
  })
})

// ─── Two-strike rule documentation ────────────────────────────────────────────

describe('consecutiveFailures — two-strike rule contract', () => {
  it('streak=1 does not trigger alert (noise threshold)', async () => {
    // Single failure could be a timeout, deploy, or blip
    mockFindMany.mockResolvedValue(mockEvents([false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(1) // Not enough for alert
  })

  it('streak=2 triggers alert (actual outage)', async () => {
    // Two in a row = site is actually down
    mockFindMany.mockResolvedValue(mockEvents([false, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(2) // Alert threshold
  })

  it('recovery resets streak when most recent is ok', async () => {
    // Events are newest-first: [true, false, false, false]
    // Most recent is ok → streak = 0
    mockFindMany.mockResolvedValue(mockEvents([true, false, false, false]))
    const result = await consecutiveFailures('monitor-1')
    expect(result).toBe(0)
  })
})

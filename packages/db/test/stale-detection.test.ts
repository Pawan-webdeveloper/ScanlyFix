/**
 * Stale monitor detection tests.
 *
 * A monitor is considered "stale" when the time since its last run exceeds
 * 3× its configured interval. This indicates the worker may be dead or
 * stuck, and the monitor's lastStatus is no longer reliable.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { getMonitorStatus } from '../src/queries/monitors.ts'

describe('getMonitorStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('null lastRunAt (never run)', () => {
    it('returns null status with isStale false', () => {
      const result = getMonitorStatus(null, null, 60)
      expect(result.status).toBeNull()
      expect(result.isStale).toBe(false)
      expect(result.label).toBe('No recent checks')
    })

    it('returns null status even if lastStatus is provided', () => {
      const result = getMonitorStatus(null, 'up', 60)
      expect(result.status).toBeNull()
      expect(result.isStale).toBe(false)
    })
  })

  describe('fresh monitors (within 3× interval)', () => {
    it('returns "up" status when lastStatus is "up"', () => {
      const now = new Date()
      const result = getMonitorStatus(now, 'up', 60)
      expect(result.status).toBe('up')
      expect(result.isStale).toBe(false)
      expect(result.label).toBe('Operational')
    })

    it('returns "down" status when lastStatus is "down"', () => {
      const now = new Date()
      const result = getMonitorStatus(now, 'down', 60)
      expect(result.status).toBe('down')
      expect(result.isStale).toBe(false)
      expect(result.label).toBe('Down')
    })

    it('returns null status when lastStatus is null', () => {
      const now = new Date()
      const result = getMonitorStatus(now, null, 60)
      expect(result.status).toBeNull()
      expect(result.isStale).toBe(false)
    })

    it('is fresh at exactly 3× interval minus 1ms', () => {
      const intervalS = 60
      const staleThresholdMs = intervalS * 1000 * 3
      const lastRunAt = new Date(Date.now() - staleThresholdMs + 1)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.isStale).toBe(false)
      expect(result.status).toBe('up')
    })
  })

  describe('stale monitors (beyond 3× interval)', () => {
    it('returns "stale" status when beyond 3× interval', () => {
      const intervalS = 60
      const staleThresholdMs = intervalS * 1000 * 3
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.status).toBe('stale')
      expect(result.isStale).toBe(true)
      expect(result.label).toBe('No recent checks')
    })

    it('is fresh at exactly 3× interval', () => {
      const intervalS = 60
      const staleThresholdMs = intervalS * 1000 * 3
      const lastRunAt = new Date(Date.now() - staleThresholdMs)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.isStale).toBe(false)
      expect(result.status).toBe('up')
    })

    it('is stale even if lastStatus was "down"', () => {
      const intervalS = 60
      const staleThresholdMs = intervalS * 1000 * 3
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1000)
      const result = getMonitorStatus(lastRunAt, 'down', intervalS)
      expect(result.status).toBe('stale')
      expect(result.isStale).toBe(true)
    })

    it('is stale even if lastStatus was null', () => {
      const intervalS = 60
      const staleThresholdMs = intervalS * 1000 * 3
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1000)
      const result = getMonitorStatus(lastRunAt, null, intervalS)
      expect(result.status).toBe('stale')
      expect(result.isStale).toBe(true)
    })
  })

  describe('different intervals', () => {
    it('handles 30s interval (every 30s check)', () => {
      const intervalS = 30
      const staleThresholdMs = intervalS * 1000 * 3 // 90s
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.isStale).toBe(true)
    })

    it('handles 5m interval (every 5m check)', () => {
      const intervalS = 300
      const staleThresholdMs = intervalS * 1000 * 3 // 15m
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.isStale).toBe(true)
    })

    it('handles 1h interval (hourly check)', () => {
      const intervalS = 3600
      const staleThresholdMs = intervalS * 1000 * 3 // 3h
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.isStale).toBe(true)
    })

    it('handles 24h interval (daily check)', () => {
      const intervalS = 86400
      const staleThresholdMs = intervalS * 1000 * 3 // 3 days
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.isStale).toBe(true)
    })
  })

  describe('label mapping', () => {
    it('returns "Operational" for fresh "up" status', () => {
      const result = getMonitorStatus(new Date(), 'up', 60)
      expect(result.label).toBe('Operational')
    })

    it('returns "Down" for fresh "down" status', () => {
      const result = getMonitorStatus(new Date(), 'down', 60)
      expect(result.label).toBe('Down')
    })

    it('returns "Unknown" for fresh null status', () => {
      const result = getMonitorStatus(new Date(), null, 60)
      expect(result.label).toBe('Unknown')
    })

    it('returns "No recent checks" for stale status', () => {
      const intervalS = 60
      const staleThresholdMs = intervalS * 1000 * 3
      const lastRunAt = new Date(Date.now() - staleThresholdMs - 1)
      const result = getMonitorStatus(lastRunAt, 'up', intervalS)
      expect(result.label).toBe('No recent checks')
    })

    it('returns "No recent checks" for never-run status', () => {
      const result = getMonitorStatus(null, null, 60)
      expect(result.label).toBe('No recent checks')
    })
  })

  /*
   * Disabled monitors have to read as paused, not as the frozen lastStatus
   * the row had at the moment of pause — pausing is what you do when a site
   * is down, so a disabled monitor's lastStatus is "down" more often than
   * not. Surfacing that frozen value as the live status is the bug.
   */
  describe('disabled monitors', () => {
    it('returns "disabled" regardless of frozen lastStatus "down"', () => {
      // The exact failure this regression guard exists for: a monitor that
      // was paused while in a failing state must NOT surface as "down" when
      // the user reopens the uptime page.
      const result = getMonitorStatus(new Date(), 'down', 60, false)
      expect(result.status).toBe('disabled')
      expect(result.isStale).toBe(false)
      expect(result.label).toBe('Paused')
    })

    it('returns "disabled" regardless of frozen lastStatus "up"', () => {
      const result = getMonitorStatus(new Date(), 'up', 60, false)
      expect(result.status).toBe('disabled')
      expect(result.isStale).toBe(false)
      expect(result.label).toBe('Paused')
    })

    it('returns "disabled" even when never run', () => {
      const result = getMonitorStatus(null, null, 60, false)
      expect(result.status).toBe('disabled')
      expect(result.label).toBe('Paused')
    })

    it('short-circuits stale detection — a paused monitor is never stale', () => {
      // lastRunAt is 24h ago and intervalS is 60s — would be stale if enabled,
      // and a stale-down reading would still look like a problem.
      const intervalS = 60
      const veryOld = new Date(Date.now() - intervalS * 1000 * 24)
      const result = getMonitorStatus(veryOld, 'down', intervalS, false)
      expect(result.status).toBe('disabled')
      expect(result.isStale).toBe(false)
    })

    it('treats the default-true signature as backward-compatible', () => {
      // Three-arg call (legacy) must still behave like an enabled monitor.
      const enabledByDefault = getMonitorStatus(new Date(), 'down', 60)
      expect(enabledByDefault.status).toBe('down')
      expect(enabledByDefault.isStale).toBe(false)
    })
  })
})

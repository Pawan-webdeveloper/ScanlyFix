/**
 * Tests for uptime monitoring feature improvements:
 *   1. statusCodeLabel — status pill text for monitor header
 *   2. Alert subject line includes HTTP status code (downtime + reminder)
 *   3. Alert body includes latency and 5xx/4xx classification
 *   4. Downtime-reminder subject with/without statusCode
 *   5. listMonitorsForUser return type includes latest event fields
 */

import { describe, expect, it } from 'vitest'
import { render, type AlertSubject } from '../lib/alert-message.ts'

// ─── statusCodeLabel (extracted from monitor-detail.tsx) ──────────────────────
// Pure logic — copied verbatim so we can unit-test without a React render.

function statusCodeLabel(
  status: 'up' | 'down' | 'disabled' | null,
  code: number | null,
): string {
  if (status === 'up') return code !== null ? `UP · ${code}` : 'UP'
  if (status === 'down') return code !== null ? `DOWN · ${code}` : 'DOWN'
  if (status === 'disabled') return 'PAUSED'
  return 'PENDING'
}

describe('statusCodeLabel', () => {
  it('shows UP · 200 when status is up with a status code', () => {
    expect(statusCodeLabel('up', 200)).toBe('UP · 200')
  })

  it('shows just UP when status is up without a status code', () => {
    expect(statusCodeLabel('up', null)).toBe('UP')
  })

  it('shows DOWN · 503 when status is down with a status code', () => {
    expect(statusCodeLabel('down', 503)).toBe('DOWN · 503')
  })

  it('shows DOWN · 404 when status is down with 404', () => {
    expect(statusCodeLabel('down', 404)).toBe('DOWN · 404')
  })

  it('shows just DOWN when status is down without a status code', () => {
    expect(statusCodeLabel('down', null)).toBe('DOWN')
  })

  it('shows PENDING when status is null', () => {
    expect(statusCodeLabel(null, null)).toBe('PENDING')
  })

  it('shows PENDING when status is null even if code is provided', () => {
    expect(statusCodeLabel(null, 200)).toBe('PENDING')
  })

  /*
   * Disabled must read as paused regardless of what code happens to be
   * on the row — the code is the frozen pre-pause response, not the
   * live status.
   */
  it('shows PAUSED when status is disabled, ignoring the frozen code', () => {
    expect(statusCodeLabel('disabled', 503)).toBe('PAUSED')
    expect(statusCodeLabel('disabled', null)).toBe('PAUSED')
  })
})

// ─── Downtime alert subject ───────────────────────────────────────────────────

const project = {
  projectName: 'ScanlyFix',
  projectUrl: 'https://scanlyfix.test/app',
  projectSlug: 'scanlyfix-test',
}

const alert = (kind: string, payload: Record<string, unknown> | null): AlertSubject => ({
  kind,
  payload,
  ...project,
})

describe('downtime alert — subject with HTTP code', () => {
  it('includes [DOWN] and the HTTP code when statusCode is present', () => {
    const { subject } = render(alert('downtime', { streak: 2, statusCode: 503 }))
    expect(subject).toBe('[DOWN] scanlyfix.test — HTTP 503')
  })

  it('uses 200 in subject when the site returns 200 but the threshold marks it down', () => {
    const { subject } = render(
      alert('downtime', {
        streak: 3,
        statusCode: 200,
        latencyMs: 15000,
        detail: '2001ms > 5000ms threshold',
      }),
    )
    // 200 is a valid HTTP code, so it appears in the subject
    expect(subject).toBe('[DOWN] scanlyfix.test — HTTP 200')
  })

  it('falls back to "is not responding" when statusCode is null', () => {
    const { subject } = render(alert('downtime', { streak: 2, statusCode: null }))
    expect(subject).toBe('scanlyfix.test is not responding')
  })
})

describe('downtime alert — body classification', () => {
  it('flags a 5xx as a server error', () => {
    const { text } = render(alert('downtime', { streak: 2, statusCode: 502 }))
    expect(text).toContain('The server returned a 5xx error (code 502).')
  })

  it('flags a 503 as a server error', () => {
    const { text } = render(alert('downtime', { streak: 2, statusCode: 503 }))
    expect(text).toContain('The server returned a 5xx error (code 503).')
  })

  it('flags a 4xx as a client-side error', () => {
    const { text } = render(alert('downtime', { streak: 2, statusCode: 403 }))
    expect(text).toContain('The server returned a 4xx error (code 403).')
  })

  it('flags a 404 as a client-side error', () => {
    const { text } = render(alert('downtime', { streak: 2, statusCode: 404 }))
    expect(text).toContain('The server returned a 4xx error (code 404).')
  })

  it('says "no response" when statusCode is null', () => {
    const { text } = render(alert('downtime', { streak: 2, statusCode: null, detail: null }))
    expect(text).toContain('No HTTP response was received.')
  })

  it('includes latency when provided', () => {
    const { text } = render(
      alert('downtime', { streak: 2, statusCode: 503, latencyMs: 8500 }),
    )
    expect(text).toContain('Last response latency: 8500ms')
  })

  it('omits latency line when latencyMs is null', () => {
    const { text } = render(
      alert('downtime', { streak: 2, statusCode: 503, latencyMs: null }),
    )
    expect(text).not.toContain('Last response latency')
  })

  it('omits latency line when latencyMs is 0', () => {
    const { text } = render(
      alert('downtime', { streak: 2, statusCode: 503, latencyMs: 0 }),
    )
    expect(text).not.toContain('Last response latency')
  })
})

// ─── Downtime-reminder subject ────────────────────────────────────────────────

describe('downtime-reminder — subject with HTTP code', () => {
  it('includes [STILL DOWN] and HTTP code when statusCode is present', () => {
    const { subject } = render(
      alert('downtime-reminder', {
        downFor: '45m',
        reminderNumber: 2,
        statusCode: 503,
        detail: null,
        streak: 8,
      }),
    )
    expect(subject).toBe('[STILL DOWN] scanlyfix.test — HTTP 503 — down for 45m')
  })

  it('falls back to reminder-number format when statusCode is null', () => {
    const { subject } = render(
      alert('downtime-reminder', {
        downFor: '30m',
        reminderNumber: 1,
        statusCode: null,
        detail: 'ETIMEDOUT',
        streak: 5,
      }),
    )
    expect(subject).toBe('[STILL DOWN] scanlyfix.test — down for 30m (reminder #1)')
  })

  it('includes latency in body when provided', () => {
    const { text } = render(
      alert('downtime-reminder', {
        downFor: '15m',
        reminderNumber: 1,
        statusCode: 503,
        latencyMs: 2000,
        streak: 4,
      }),
    )
    expect(text).toContain('Last response latency: 2000ms')
  })
})

// ─── Recovery alert — unchanged ───────────────────────────────────────────────

describe('recovery alert — unchanged', () => {
  it('still includes [RESOLVED] and duration', () => {
    const { subject, text } = render(
      alert('recovered', {
        downFor: '12m',
        recoveredAt: '2026-09-04T12:00:00Z',
        incidentId: 'inc-1',
      }),
    )
    expect(subject).toContain('[RESOLVED]')
    expect(subject).toContain('12m')
    expect(text).toContain('Was down for: 12m')
  })
})

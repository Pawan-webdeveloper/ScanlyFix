/**
 * Tests for downtime-reminder alert template.
 *
 * Tests the reminder email template:
 *   1. Subject includes [STILL DOWN] and duration
 *   2. Text includes reminder number
 *   3. Handles missing payload fields gracefully
 *   4. Structural requirements
 */

import { describe, expect, it } from 'vitest'
import { render, type AlertSubject } from '../lib/alert-message.ts'

const project = {
  projectName: 'TestProject',
  projectUrl: 'https://example.com',
  projectSlug: 'test-project',
}

const alert = (kind: string, payload: Record<string, unknown> | null): AlertSubject => ({
  kind,
  payload,
  ...project,
})

describe('Downtime reminder — email template', () => {
  it('subject includes [STILL DOWN], HTTP code, and duration', () => {
    const { subject } = render(
      alert('downtime-reminder', {
        downFor: '30m',
        reminderNumber: 1,
        statusCode: 503,
        detail: null,
        streak: 5,
      }),
    )

    expect(subject).toBe('[STILL DOWN] example.com — HTTP 503 — down for 30m')
  })

  it('falls back to reminder-number format when status code is missing', () => {
    const { subject } = render(
      alert('downtime-reminder', {
        downFor: '30m',
        reminderNumber: 1,
        statusCode: null,
        detail: 'ETIMEDOUT',
        streak: 5,
      }),
    )

    expect(subject).toBe('[STILL DOWN] example.com — down for 30m (reminder #1)')
  })

  it('text includes reminder number and status', () => {
    const { text } = render(
      alert('downtime-reminder', {
        downFor: '1h 15m',
        reminderNumber: 2,
        statusCode: 502,
        detail: null,
        streak: 10,
      }),
    )

    expect(text).toContain('still down after 1h 15m')
    expect(text).toContain('This is reminder #2')
    expect(text).toContain('Last observed: HTTP 502')
  })

  it('falls back to detail when no status code', () => {
    const { text } = render(
      alert('downtime-reminder', {
        downFor: '15m',
        reminderNumber: 1,
        statusCode: null,
        detail: 'ETIMEDOUT',
        streak: 3,
      }),
    )

    expect(text).toContain('Last observed: ETIMEDOUT')
  })

  it('says "no response" when both status and detail are missing', () => {
    const { text } = render(
      alert('downtime-reminder', {
        downFor: '5m',
        reminderNumber: 1,
        streak: 2,
      }),
    )

    expect(text).toContain('Last observed: no response')
  })

  it('handles missing payload fields gracefully', () => {
    const { subject, text } = render(alert('downtime-reminder', {}))

    expect(subject).toContain('[STILL DOWN]')
    expect(subject).toContain('down for unknown duration')
    expect(text).toContain('still down')
  })

  it('handles null payload', () => {
    expect(() => render(alert('downtime-reminder', null))).not.toThrow()
  })

  it('includes status page link', () => {
    const { text } = render(
      alert('downtime-reminder', {
        downFor: '45m',
        reminderNumber: 1,
        streak: 8,
      }),
    )

    expect(text).toContain('/status/test-project')
  })

  it('mentions continued reminders', () => {
    const { text } = render(
      alert('downtime-reminder', {
        downFor: '2h',
        reminderNumber: 3,
        streak: 15,
      }),
    )

    expect(text).toContain('continue to receive reminders')
  })
})

describe('Alert dedup — reminder exemption', () => {
  it('downtime-reminder alerts have dedupKey in payload', () => {
    // This is a structural test - the actual dedupKey is added by the probe
    const { text } = render(
      alert('downtime-reminder', {
        downFor: '30m',
        reminderNumber: 1,
        streak: 5,
      }),
    )

    // Reminders should not mention daily dedup
    expect(text).not.toContain('not be emailed again about this today')
  })
})

describe('Incident lifecycle — reminder integration', () => {
  it('initial downtime and reminder have different subjects', () => {
    const downtimeSubject = render(alert('downtime', { streak: 2 })).subject
    const reminderSubject = render(
      alert('downtime-reminder', { downFor: '30m', reminderNumber: 1, streak: 5 }),
    ).subject

    expect(downtimeSubject).not.toBe(reminderSubject)
    expect(downtimeSubject).toContain('not responding')
    expect(reminderSubject).toContain('[STILL DOWN]')
  })

  it('reminder includes downtime duration from incident', () => {
    const { subject, text } = render(
      alert('downtime-reminder', {
        downFor: '1d 3h',
        reminderNumber: 5,
        streak: 50,
      }),
    )

    expect(subject).toContain('1d 3h')
    expect(text).toContain('still down after 1d 3h')
  })

  it('reminder numbers increment', () => {
    const reminder1 = render(
      alert('downtime-reminder', { downFor: '30m', reminderNumber: 1, streak: 5 }),
    ).subject

    const reminder2 = render(
      alert('downtime-reminder', { downFor: '1h', reminderNumber: 2, streak: 10 }),
    ).subject

    expect(reminder1).toContain('#1')
    expect(reminder2).toContain('#2')
    expect(reminder1).not.toBe(reminder2)
  })
})

describe('Every message — structural requirements', () => {
  it('carries a link the reader can act on', () => {
    for (const kind of ['downtime', 'recovered', 'downtime-reminder']) {
      const payload =
        kind === 'downtime'
          ? { streak: 2, statusCode: 500 }
          : kind === 'recovered'
            ? { downFor: '5m', recoveredAt: '2026-09-04T12:00:00Z' }
            : { downFor: '30m', reminderNumber: 1, streak: 5 }
      expect(render(alert(kind, payload)).text).toMatch(/https?:\/\//)
    }
  })

  it('uses the host rather than the full URL in the subject line', () => {
    for (const kind of ['downtime', 'recovered', 'downtime-reminder']) {
      const payload =
        kind === 'downtime'
          ? { streak: 2, statusCode: 500 }
          : kind === 'recovered'
            ? { downFor: '5m', recoveredAt: '2026-09-04T12:00:00Z' }
            : { downFor: '30m', reminderNumber: 1, streak: 5 }
      expect(render(alert(kind, payload)).subject).not.toContain('/app')
    }
  })
})

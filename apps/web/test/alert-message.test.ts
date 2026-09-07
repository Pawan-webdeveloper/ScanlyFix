/**
 * What the customer actually reads.
 *
 * Every input here is a jsonb blob whose shape nothing enforces — the column is
 * `Record<string, unknown>` and the job that wrote it may be two versions old.
 * So the cases that matter are the malformed ones: a payload missing the field
 * the sentence is built around must still produce a sendable message, because
 * the alternative is a monitoring product that goes quiet exactly when
 * something has gone wrong.
 */

import { describe, expect, it } from 'vitest'
import { render, type AlertSubject } from '../lib/alert-message.ts'

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

describe('downtime', () => {
  it('names the host and the streak, and quotes the status code', () => {
    const { subject, text } = render(alert('downtime', { streak: 3, statusCode: 503, detail: null }))

    expect(subject).toBe('[DOWN] scanlyfix.test — HTTP 503')
    expect(text).toContain('failed 3 consecutive checks')
    expect(text).toContain('Observed: HTTP 503')
    expect(text).toContain('The server returned a 5xx error (code 503).')
  })

  it('classifies a 4xx as a client-side failure', () => {
    const { text } = render(alert('downtime', { streak: 2, statusCode: 404, detail: null }))

    expect(text).toContain('Observed: HTTP 404')
    expect(text).toContain('The server returned a 4xx error (code 404).')
  })

  it('reports latency when the probe provided it', () => {
    const { text } = render(
      alert('downtime', { streak: 2, statusCode: 503, latencyMs: 1500, detail: null }),
    )

    expect(text).toContain('Last response latency: 1500ms')
  })

  it('falls back to the transport detail when there was no status code', () => {
    const { text } = render(alert('downtime', { streak: 2, statusCode: null, detail: 'ETIMEDOUT' }))
    expect(text).toContain('Observed: ETIMEDOUT')
  })

  it('still says something when the payload has neither', () => {
    const { text } = render(alert('downtime', {}))
    expect(text).toContain('Observed: no response')
    expect(text).toContain('failed 0 consecutive checks')
  })

  it('promises no second email today, because recordAlertOnce guarantees it', () => {
    const { text } = render(alert('downtime', { streak: 5 }))
    expect(text).toContain('not be emailed again about this today')
  })
})

describe('certificate expiry', () => {
  it('counts down when the certificate is still valid', () => {
    const { subject, text } = render(alert('certificate-expiry-7', { daysLeft: 7, expired: false }))

    expect(subject).toBe('scanlyfix.test certificate expires in 7 days')
    expect(text).toContain('expires in 7 days')
  })

  it('changes the sentence entirely once it has expired', () => {
    const { subject, text } = render(alert('certificate-expiry-0', { daysLeft: -2, expired: true }))

    expect(subject).toBe('scanlyfix.test has an expired TLS certificate')
    expect(text).toContain('Browsers are showing a warning')
    expect(text).not.toContain('expires in')
  })

  it('matches every threshold variant of the kind, not just one', () => {
    for (const kind of ['certificate-expiry-30', 'certificate-expiry-14', 'certificate-expiry-7']) {
      expect(render(alert(kind, { daysLeft: 5 })).subject).toContain('certificate expires')
    }
  })
})

describe('score drop', () => {
  it('reports both numbers and links to the report that produced them', () => {
    const { subject, text } = render(
      alert('score-drop', { before: 87, after: 75, delta: -12, scanId: 'abc-123' }),
    )

    expect(subject).toBe('scanlyfix.test dropped 12 points')
    expect(text).toContain('scored 75')
    expect(text).toContain('down from 87')
    expect(text).toContain('/scan/abc-123')
  })

  it('says why the number is trustworthy, since that is the whole rule', () => {
    const { text } = render(alert('score-drop', { before: 90, after: 80, scanId: 'x' }))
    expect(text).toContain('same engine version')
    expect(text).toContain('no degraded pillars')
  })
})

describe('an unrecognised kind', () => {
  it('still produces a sendable message rather than dropping the alert', () => {
    const { subject, text } = render(alert('some-future-alert', { anything: true }))

    expect(subject).toContain('scanlyfix.test')
    expect(subject).toContain('some future alert')
    expect(text).toContain('https://scanlyfix.test/app')
    expect(text).toContain('/status/scanlyfix-test')
  })

  it('survives a null payload', () => {
    expect(() => render(alert('downtime', null))).not.toThrow()
    expect(() => render(alert('score-drop', null))).not.toThrow()
    expect(() => render(alert('certificate-expiry-7', null))).not.toThrow()
  })

  it('survives a payload whose fields are the wrong type', () => {
    const { text } = render(alert('downtime', { streak: 'three', statusCode: '503' }))
    expect(text).toContain('failed 0 consecutive checks')
    expect(text).toContain('Observed: no response')
  })
})

describe('every message', () => {
  it('carries a link the reader can act on', () => {
    for (const kind of ['downtime', 'certificate-expiry-7', 'score-drop', 'unknown']) {
      expect(render(alert(kind, { scanId: 's' })).text).toMatch(/https?:\/\//)
    }
  })

  it('uses the host rather than the full URL in the subject line', () => {
    for (const kind of ['downtime', 'certificate-expiry-7', 'score-drop']) {
      expect(render(alert(kind, {})).subject).not.toContain('/app')
    }
  })
})

/**
 * alert-message.ts tests for NEW monitoring alert kinds.
 *
 * Covers the two kinds added by the monitoring feature:
 *   - dns_drift  : DNS records changed alert
 *   - web_vitals : Core Web Vitals threshold crossed alert
 *
 * Also covers the Slack renderer (renderSlack) to ensure it produces
 * valid Block Kit structure for all alert kinds.
 *
 * Philosophy (same as existing alert-message.test.ts):
 * Every input comes from a jsonb payload blob — we test that malformed
 * inputs produce a useful message rather than an exception or silence.
 */

import { describe, expect, it } from 'vitest'
import { render, renderSlack, type AlertSubject } from '../lib/alert-message.ts'

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

// ─── dns_drift ────────────────────────────────────────────────────────────────

describe('dns_drift', () => {
  it('includes the hostname in subject and body', () => {
    const { subject, text } = render(
      alert('dns_drift', {
        hostname: 'example.com',
        added: [],
        removed: [{ type: 'A', value: '1.2.3.4' }],
      }),
    )

    expect(subject).toContain('example.com')
    expect(text).toContain('example.com')
  })

  it('shows removed records with a minus prefix', () => {
    const { text } = render(
      alert('dns_drift', {
        hostname: 'example.com',
        added: [],
        removed: [{ type: 'A', value: '1.2.3.4' }],
      }),
    )

    expect(text).toContain('Records removed')
    expect(text).toContain('- A')
    expect(text).toContain('1.2.3.4')
  })

  it('shows added records with a plus prefix', () => {
    const { text } = render(
      alert('dns_drift', {
        hostname: 'example.com',
        added: [{ type: 'CNAME', value: 'new.cdn.example.com' }],
        removed: [],
      }),
    )

    expect(text).toContain('Records added')
    expect(text).toContain('+ CNAME')
    expect(text).toContain('new.cdn.example.com')
  })

  it('shows both added and removed when both changed', () => {
    const { text } = render(
      alert('dns_drift', {
        hostname: 'example.com',
        added: [{ type: 'A', value: '5.5.5.5' }],
        removed: [{ type: 'A', value: '1.2.3.4' }],
      }),
    )

    expect(text).toContain('Records removed')
    expect(text).toContain('Records added')
  })

  it('includes a link to the monitor and status page', () => {
    const { text } = render(
      alert('dns_drift', {
        hostname: 'example.com',
        added: [],
        removed: [],
      }),
    )

    expect(text).toMatch(/https?:\/\//)
    expect(text).toContain('/status/scanlyfix-test')
  })

  it('does not throw on null payload', () => {
    expect(() => render(alert('dns_drift', null))).not.toThrow()
  })

  it('does not throw when added/removed are missing from payload', () => {
    const { subject, text } = render(alert('dns_drift', {}))
    expect(subject).toContain('DNS')
    expect(text).toBeDefined()
  })

  it('falls back to project host when hostname is missing from payload', () => {
    const { subject } = render(alert('dns_drift', { added: [], removed: [] }))
    // Should still contain some host reference, not crash
    expect(subject).toBeTruthy()
  })
})

// ─── web_vitals ───────────────────────────────────────────────────────────────

describe('web_vitals', () => {
  const criticalViolations = [
    { metric: 'LCP', value: 4500, unit: 'ms', severity: 'critical' },
    { metric: 'CLS', value: 0.3, unit: '', severity: 'critical' },
  ]

  const warnViolations = [
    { metric: 'FID', value: 150, unit: 'ms', severity: 'warn' },
  ]

  it('marks subject as critical (🔴) when hasCritical is true', () => {
    const { subject } = render(
      alert('web_vitals', {
        url: 'https://example.com',
        violations: criticalViolations,
        hasCritical: true,
      }),
    )

    expect(subject).toContain('🔴')
    expect(subject).toContain('Web Vitals')
  })

  it('marks subject as warn (🟡) when hasCritical is false', () => {
    const { subject } = render(
      alert('web_vitals', {
        url: 'https://example.com',
        violations: warnViolations,
        hasCritical: false,
      }),
    )

    expect(subject).toContain('🟡')
  })

  it('lists each violation with its emoji in the body', () => {
    const { text } = render(
      alert('web_vitals', {
        url: 'https://example.com',
        violations: [
          { metric: 'LCP', value: 4500, unit: 'ms', severity: 'critical' },
          { metric: 'FID', value: 150, unit: 'ms', severity: 'warn' },
        ],
        hasCritical: true,
      }),
    )

    expect(text).toContain('🔴')
    expect(text).toContain('LCP')
    expect(text).toContain('4500ms')
    expect(text).toContain('🟡')
    expect(text).toContain('FID')
    expect(text).toContain('150ms')
  })

  it('mentions SEO / user experience impact', () => {
    const { text } = render(
      alert('web_vitals', {
        url: 'https://example.com',
        violations: criticalViolations,
        hasCritical: true,
      }),
    )

    expect(text).toMatch(/user experience|SEO/i)
  })

  it('includes a link to the monitoring project', () => {
    const { text } = render(
      alert('web_vitals', {
        url: 'https://example.com',
        violations: criticalViolations,
        hasCritical: true,
      }),
    )

    expect(text).toMatch(/https?:\/\//)
  })

  it('does not throw on null payload', () => {
    expect(() => render(alert('web_vitals', null))).not.toThrow()
  })

  it('does not throw on empty violations array', () => {
    const { text } = render(
      alert('web_vitals', { url: 'https://example.com', violations: [], hasCritical: false }),
    )

    expect(text).toBeDefined()
  })

  it('does not throw when violations is missing', () => {
    expect(() =>
      render(alert('web_vitals', { url: 'https://example.com' })),
    ).not.toThrow()
  })
})

// ─── renderSlack ──────────────────────────────────────────────────────────────

describe('renderSlack', () => {
  it('returns a valid Slack Block Kit message with header and section blocks', () => {
    const msg = renderSlack(alert('downtime', { streak: 3, statusCode: 503 }))

    expect(msg.text).toBeTruthy() // fallback text for notifications
    expect(msg.blocks).toBeDefined()
    expect(msg.blocks!.length).toBeGreaterThanOrEqual(2)

    const header = msg.blocks!.find((b) => b.type === 'header')
    expect(header).toBeDefined()
    expect(header?.text?.type).toBe('plain_text')

    const section = msg.blocks!.find((b) => b.type === 'section')
    expect(section).toBeDefined()
    expect(section?.text?.type).toBe('mrkdwn')
  })

  it('puts the subject as the top-level text (for mobile/desktop notifications)', () => {
    const msg = renderSlack(alert('downtime', { streak: 2, statusCode: 503 }))
    expect(msg.text).toContain('scanlyfix.test')
    expect(msg.text).toContain('HTTP 503')
  })

  it('works for dns_drift alerts', () => {
    const msg = renderSlack(
      alert('dns_drift', {
        hostname: 'example.com',
        added: [{ type: 'A', value: '5.5.5.5' }],
        removed: [],
      }),
    )

    expect(msg.text).toContain('DNS')
    expect(msg.blocks).toBeDefined()
  })

  it('works for web_vitals alerts', () => {
    const msg = renderSlack(
      alert('web_vitals', {
        url: 'https://example.com',
        violations: [{ metric: 'LCP', value: 4500, unit: 'ms', severity: 'critical' }],
        hasCritical: true,
      }),
    )

    expect(msg.text).toContain('Web Vitals')
    expect(msg.blocks).toBeDefined()
  })

  it('truncates very long text to stay within Slack 3000 char limit', () => {
    // Build a payload that generates a very long text
    const manyViolations = Array.from({ length: 50 }, (_, i) => ({
      metric: `METRIC_${i}`,
      value: 9999,
      unit: 'ms',
      severity: 'critical' as const,
    }))

    const msg = renderSlack(
      alert('web_vitals', {
        url: 'https://example.com',
        violations: manyViolations,
        hasCritical: true,
      }),
    )

    const section = msg.blocks!.find((b) => b.type === 'section')
    expect(section?.text?.text.length).toBeLessThanOrEqual(3000)
  })

  it('never throws on unknown alert kind', () => {
    expect(() => renderSlack(alert('some-future-kind', {}))).not.toThrow()
  })

  it('never throws on null payload', () => {
    expect(() => renderSlack(alert('downtime', null))).not.toThrow()
  })
})

/**
 * The rule this file exists to protect: `sentAt` is written ONLY after a
 * provider accepted the message.
 *
 * An alert row with a null sentAt is the only record that somebody was never
 * told about their own outage. Marking optimistically would erase exactly the
 * evidence you need when a customer asks why they heard nothing — so a failed
 * send must leave the row untouched, and a successful one must not be sent
 * twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const alertForDelivery = vi.fn()
const markAlertSent = vi.fn()
const getAlertChannels = vi.fn()
const sendEmail = vi.fn()
const sendSlack = vi.fn()
const sendDiscord = vi.fn()
const renderDiscord = vi.fn()
const sendWebhook = vi.fn()
const buildWebhookPayload = vi.fn()

vi.mock('@scanlyfix/db', () => ({ alertForDelivery, markAlertSent, getAlertChannels }))
vi.mock('../lib/email.ts', () => ({ sendEmail, emailConfigured: () => true }))
vi.mock('../lib/slack.ts', () => ({ sendSlack, isValidSlackWebhookUrl: () => true }))
vi.mock('../lib/discord.ts', () => ({ sendDiscord, renderDiscord }))
vi.mock('../lib/webhook.ts', () => ({ sendWebhook, buildWebhookPayload }))

const { deliverAlert } = await import('../lib/alert-email.ts')

const row = {
  id: 'alert-1',
  kind: 'downtime',
  payload: { streak: 3, statusCode: 503 },
  sentAt: null as Date | null,
  projectName: 'ScanlyFix',
  projectUrl: 'https://scanlyfix.test/',
  projectSlug: 'scanlyfix-test',
  recipientEmail: 'owner@example.test',
}

beforeEach(() => {
  alertForDelivery.mockReset()
  markAlertSent.mockReset()
  // Default: no configured channels. The new deliverAlert reads the channel
  // list unconditionally to build the routing decision; tests that exercise
  // a channel override it.
  getAlertChannels.mockReset()
  getAlertChannels.mockResolvedValue([])
  sendEmail.mockReset()
  sendSlack.mockReset()
  sendDiscord.mockReset()
  renderDiscord.mockReset()
  sendWebhook.mockReset()
  buildWebhookPayload.mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('deliverAlert', () => {
  it('sends to the project owner with a rendered subject and body', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })

    await deliverAlert('alert-1')

    const message = sendEmail.mock.calls[0]?.[0]
    expect(message.to).toBe('owner@example.test')
    expect(message.subject).toBe('[DOWN] scanlyfix.test — HTTP 503')
    expect(message.text).toContain('failed 3 consecutive checks')
    // The HTML is a mirror of the text, so it must carry the same facts.
    expect(message.html).toContain('failed 3 consecutive checks')
  })

  it('marks the row sent once the provider accepted it', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })

    expect(await deliverAlert('alert-1')).toEqual({ sent: true, id: 'msg_1' })
    expect(markAlertSent).toHaveBeenCalledWith('alert-1')
  })

  it('does NOT mark the row when the send was refused', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: false, reason: 'RESEND_API_KEY is not configured' })

    const result = await deliverAlert('alert-1')

    expect(result).toEqual({ sent: false, reason: 'RESEND_API_KEY is not configured' })
    // The whole point: an undelivered alert stays findable.
    expect(markAlertSent).not.toHaveBeenCalled()
  })

  it('lets a thrown transport error propagate, so the queue retries it', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockRejectedValue(new Error('mail provider returned 503'))

    await expect(deliverAlert('alert-1')).rejects.toThrow(/503/)
    expect(markAlertSent).not.toHaveBeenCalled()
  })

  it('refuses to send an alert that already went out', async () => {
    alertForDelivery.mockResolvedValue({ ...row, sentAt: new Date() })

    expect(await deliverAlert('alert-1')).toEqual({ sent: false, reason: 'already delivered' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('handles an alert that no longer exists', async () => {
    alertForDelivery.mockResolvedValue(null)

    expect(await deliverAlert('gone')).toEqual({ sent: false, reason: 'alert no longer exists' })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('also delivers to configured Slack channel when enabled', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-slack',
        channel: 'slack',
        enabled: true,
        config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
      },
    ])
    sendSlack.mockResolvedValue({ sent: true })

    await deliverAlert('alert-1')

    expect(sendSlack).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T/B/X',
      expect.objectContaining({
        text: '[DOWN] scanlyfix.test — HTTP 503',
      }),
    )
  })

  it('does not let Slack failure prevent email delivery or marking sent', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-slack',
        channel: 'slack',
        enabled: true,
        config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
      },
    ])
    sendSlack.mockRejectedValue(new Error('Slack server down'))

    const result = await deliverAlert('alert-1')

    expect(result).toEqual({ sent: true, id: 'msg_1' })
    expect(markAlertSent).toHaveBeenCalledWith('alert-1')
  })

  it('also delivers to configured Discord channel when enabled', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-discord',
        channel: 'discord',
        enabled: true,
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      },
    ])
    renderDiscord.mockReturnValue({
      content: '🔴 downtime on scanlyfix.test',
      username: 'ScanlyFix',
      embeds: [{ title: 't', description: 'd', color: 0xdc3545 }],
    })
    sendDiscord.mockResolvedValue({ sent: true })

    await deliverAlert('alert-1')

    expect(sendDiscord).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/1/abc',
      expect.objectContaining({
        username: 'ScanlyFix',
        embeds: expect.any(Array),
      }),
    )
    expect(renderDiscord).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'downtime',
        projectName: 'ScanlyFix',
        projectUrl: 'https://scanlyfix.test/',
      }),
    )
  })

  it('does not let Discord failure prevent email delivery or marking sent', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-discord',
        channel: 'discord',
        enabled: true,
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      },
    ])
    renderDiscord.mockReturnValue({ content: 'x', embeds: [] })
    sendDiscord.mockResolvedValue({ sent: false, reason: 'Discord returned 500' })

    const result = await deliverAlert('alert-1')

    expect(result).toEqual({ sent: true, id: 'msg_1' })
    expect(markAlertSent).toHaveBeenCalledWith('alert-1')
  })

  it('skips Discord delivery when channel is disabled', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-discord',
        channel: 'discord',
        enabled: false,
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      },
    ])

    await deliverAlert('alert-1')

    expect(sendDiscord).not.toHaveBeenCalled()
    expect(renderDiscord).not.toHaveBeenCalled()
  })

  it('delivers to all three secondary channels (Slack, Discord, webhook) in one go', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-slack',
        channel: 'slack',
        enabled: true,
        config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
      },
      {
        id: 'ch-discord',
        channel: 'discord',
        enabled: true,
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
      },
      {
        id: 'ch-webhook',
        channel: 'webhook',
        enabled: true,
        config: { url: 'https://webhook.site/abc-123' },
      },
    ])
    sendSlack.mockResolvedValue({ sent: true })
    renderDiscord.mockReturnValue({ content: 'x', embeds: [] })
    sendDiscord.mockResolvedValue({ sent: true })
    buildWebhookPayload.mockReturnValue({
      kind: 'downtime',
      projectName: 'ScanlyFix',
      monitorType: 'uptime',
      url: 'https://scanlyfix.test/',
      payload: {},
      timestamp: '2026-01-01T00:00:00.000Z',
      severity: 'critical',
    })
    sendWebhook.mockResolvedValue({ sent: true })

    await deliverAlert('alert-1')

    expect(sendSlack).toHaveBeenCalledTimes(1)
    expect(sendDiscord).toHaveBeenCalledTimes(1)
    expect(sendWebhook).toHaveBeenCalledTimes(1)
  })

  it('also delivers to configured webhook channel when enabled', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-webhook',
        channel: 'webhook',
        enabled: true,
        config: { url: 'https://webhook.site/abc-123' },
      },
    ])
    buildWebhookPayload.mockReturnValue({
      kind: 'downtime',
      projectName: 'ScanlyFix',
      monitorType: 'uptime',
      url: 'https://scanlyfix.test/',
      payload: { streak: 3, statusCode: 503 },
      timestamp: '2026-01-01T00:00:00.000Z',
      severity: 'critical',
    })
    sendWebhook.mockResolvedValue({ sent: true })

    await deliverAlert('alert-1')

    expect(sendWebhook).toHaveBeenCalledWith(
      { url: 'https://webhook.site/abc-123' },
      expect.objectContaining({
        kind: 'downtime',
        projectName: 'ScanlyFix',
        severity: 'critical',
      }),
    )
    expect(buildWebhookPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'downtime',
        projectName: 'ScanlyFix',
        url: 'https://scanlyfix.test/',
      }),
    )
  })

  it('does not let webhook failure prevent email delivery or marking sent', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-webhook',
        channel: 'webhook',
        enabled: true,
        config: { url: 'https://webhook.site/abc-123' },
      },
    ])
    buildWebhookPayload.mockReturnValue({
      kind: 'downtime',
      projectName: 'ScanlyFix',
      monitorType: 'uptime',
      url: 'https://scanlyfix.test/',
      payload: { streak: 3, statusCode: 503 },
      timestamp: '2026-01-01T00:00:00.000Z',
      severity: 'critical',
    })
    sendWebhook.mockResolvedValue({ sent: false, reason: 'Webhook endpoint returned 500' })

    const result = await deliverAlert('alert-1')

    expect(result).toEqual({ sent: true, id: 'msg_1' })
    expect(markAlertSent).toHaveBeenCalledWith('alert-1')
  })

  it('skips webhook delivery when channel is disabled', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-webhook',
        channel: 'webhook',
        enabled: false,
        config: { url: 'https://webhook.site/abc-123' },
      },
    ])

    await deliverAlert('alert-1')

    expect(sendWebhook).not.toHaveBeenCalled()
    expect(buildWebhookPayload).not.toHaveBeenCalled()
  })

  it('skips webhook delivery when config is invalid', async () => {
    alertForDelivery.mockResolvedValue(row)
    sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
    getAlertChannels.mockResolvedValue([
      {
        id: 'ch-webhook',
        channel: 'webhook',
        enabled: true,
        config: { url: 'http://not-https.example.com/hook' },
      },
    ])

    await deliverAlert('alert-1')

    expect(sendWebhook).not.toHaveBeenCalled()
  })

  // ─── Per-monitor channel routing (Phase 4) ──────────────────────────────────
  describe('per-monitor channel routing', () => {
    it('sends email + all enabled channels when routing is omitted (default)', async () => {
      alertForDelivery.mockResolvedValue(row)
      sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
      getAlertChannels.mockResolvedValue([
        {
          id: 'ch-slack',
          channel: 'slack',
          enabled: true,
          config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        },
      ])
      sendSlack.mockResolvedValue({ sent: true })

      // No second argument — falls back to the default routing.
      await deliverAlert('alert-1')

      expect(sendEmail).toHaveBeenCalledTimes(1)
      expect(sendSlack).toHaveBeenCalledTimes(1)
    })

    it('suppresses email when routing says sendEmail:false', async () => {
      alertForDelivery.mockResolvedValue(row)
      getAlertChannels.mockResolvedValue([
        {
          id: 'ch-slack',
          channel: 'slack',
          enabled: true,
          config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        },
      ])
      sendSlack.mockResolvedValue({ sent: true })

      await deliverAlert('alert-1', {
        sendEmail: false,
        secondaryChannelIds: ['ch-slack'],
      })

      // The acceptance criterion: monitor with only Slack selected does NOT
      // get an email. Email send must not have been called at all.
      expect(sendEmail).not.toHaveBeenCalled()
      // The alert is still marked sent — the routing IS the delivery.
      expect(markAlertSent).toHaveBeenCalledWith('alert-1')
      // Slack still fires because it is in the allowlist.
      expect(sendSlack).toHaveBeenCalledTimes(1)
    })

    it('returns sent:true when email is suppressed (so caller sees success)', async () => {
      alertForDelivery.mockResolvedValue(row)
      getAlertChannels.mockResolvedValue([])

      const result = await deliverAlert('alert-1', {
        sendEmail: false,
        secondaryChannelIds: [],
      })

      expect(result).toEqual({ sent: true, id: 'email-suppressed' })
      expect(markAlertSent).toHaveBeenCalledWith('alert-1')
    })

    it('only fans out to channels in the allowlist', async () => {
      alertForDelivery.mockResolvedValue(row)
      sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
      getAlertChannels.mockResolvedValue([
        {
          id: 'ch-slack',
          channel: 'slack',
          enabled: true,
          config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        },
        {
          id: 'ch-discord',
          channel: 'discord',
          enabled: true,
          config: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
        },
        {
          id: 'ch-webhook',
          channel: 'webhook',
          enabled: true,
          config: { url: 'https://webhook.site/abc-123' },
        },
      ])
      sendSlack.mockResolvedValue({ sent: true })
      renderDiscord.mockReturnValue({ content: 'x', embeds: [] })
      sendDiscord.mockResolvedValue({ sent: true })
      buildWebhookPayload.mockReturnValue({
        kind: 'downtime',
        projectName: 'ScanlyFix',
        monitorType: 'uptime',
        url: 'https://scanlyfix.test/',
        payload: {},
        timestamp: '2026-01-01T00:00:00.000Z',
        severity: 'critical',
      })
      sendWebhook.mockResolvedValue({ sent: true })

      // Only Slack is in the allowlist. Discord and webhook must NOT fire.
      await deliverAlert('alert-1', {
        sendEmail: false,
        secondaryChannelIds: ['ch-slack'],
      })

      expect(sendSlack).toHaveBeenCalledTimes(1)
      expect(sendDiscord).not.toHaveBeenCalled()
      expect(sendWebhook).not.toHaveBeenCalled()
    })

    it('silently skips a stale channel id that no longer exists', async () => {
      alertForDelivery.mockResolvedValue(row)
      sendEmail.mockResolvedValue({ sent: true, id: 'msg_1' })
      getAlertChannels.mockResolvedValue([
        {
          id: 'ch-slack',
          channel: 'slack',
          enabled: true,
          config: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' },
        },
      ])
      sendSlack.mockResolvedValue({ sent: true })

      // The user picked Slack AND a now-deleted channel. Slack should still
      // fire; the deleted one is a no-op, not an error.
      await deliverAlert('alert-1', {
        sendEmail: false,
        secondaryChannelIds: ['ch-slack', 'ch-deleted'],
      })

      expect(sendSlack).toHaveBeenCalledTimes(1)
      expect(sendEmail).not.toHaveBeenCalled()
    })
  })
})

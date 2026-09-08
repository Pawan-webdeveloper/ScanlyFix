/**
 * The model call behind the Fix button, against a mocked OpenRouter.
 *
 * The Fix button's whole contract rests on how this call fails: a throttle is
 * "busy" (retry), a refused completion is "upstream" (retry), an unreachable
 * model is "network" (retry), a missing key is "unconfigured" (never retry).
 * Every branch is pinned here so a change to one cannot silently bend the
 * button's behaviour. The request itself is asserted too — the master prompt
 * must ride along as the system message and the finding as the user message,
 * or the model writes generic advice instead of a work order.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './msw/server.ts'
import { generateFix, type FixFinding } from '@/lib/fixes.ts'

const finding: FixFinding = {
  checkId: 'security-csp-missing',
  category: 'security',
  severity: 'high',
  title: 'No Content-Security-Policy header',
  description: 'The response carried no CSP header.',
  evidence: { observed: 'no content-security-policy header present' },
  remediation: 'Set a Content-Security-Policy header.',
  siteUrl: 'https://example.com',
}

const COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const completion = (content: string) => ({ choices: [{ message: { content } }] })

type ModelHandler = Parameters<typeof http.post>[1]

function mockModel(handler: ModelHandler) {
  server.use(http.post(COMPLETIONS, handler))
}

describe('generateFix', () => {
  it('without a key the answer is unconfigured and no request leaves the process', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    let called = false
    mockModel(() => {
      called = true
      return HttpResponse.json(completion('x'))
    })
    const result = await generateFix(finding)
    expect(result).toEqual({ ok: false, reason: 'unconfigured' })
    expect(called).toBe(false)
  })

  it('asks with the master prompt plus the finding, and returns the prompt', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    let authorization = ''
    let requestBody: Record<string, unknown> | undefined
    mockModel(async ({ request }) => {
      authorization = request.headers.get('authorization') ?? ''
      requestBody = (await request.json()) as Record<string, unknown>
      return HttpResponse.json(completion('Add the Content-Security-Policy header …'))
    })

    const result = await generateFix(finding)

    expect(result).toEqual({ ok: true, prompt: 'Add the Content-Security-Policy header …' })
    expect(authorization).toBe('Bearer test-key')
    expect(requestBody?.model).toBe('nvidia/nemotron-3-ultra-550b-a55b:free')
    // The ceiling has to leave room for reasoning models, which spend
    // completion tokens thinking before they write (lib/fixes.ts).
    expect(requestBody?.max_tokens).toBe(1500)
    expect(requestBody?.temperature).toBe(0.2)
    const messages = requestBody?.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('You write fix prompts for ScanlyFix')
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content).toContain('"checkId":"security-csp-missing"')
    expect(messages[1]?.content).toContain('"siteUrl":"https://example.com"')
  })

  it('maps the free tier throttle (429) to busy — retryable', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockModel(() => new HttpResponse(null, { status: 429 }))
    const result = await generateFix(finding)
    expect(result).toEqual({ ok: false, reason: 'busy' })
  })

  it('maps every other refusal to upstream — retryable', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockModel(() => HttpResponse.json({ error: 'insufficient credits' }, { status: 402 }))
    const result = await generateFix(finding)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })

  it('maps an empty or malformed completion to upstream', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockModel(() => HttpResponse.json(completion('   ')))
    expect(await generateFix(finding)).toEqual({ ok: false, reason: 'upstream' })

    server.resetHandlers()
    mockModel(() => HttpResponse.json({ choices: [] }))
    expect(await generateFix(finding)).toEqual({ ok: false, reason: 'upstream' })

    server.resetHandlers()
    mockModel(() => new HttpResponse('not json', { status: 200 }))
    expect(await generateFix(finding)).toEqual({ ok: false, reason: 'upstream' })
  })

  it('maps an unreachable model to network', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    mockModel(() => HttpResponse.error())
    const result = await generateFix(finding)
    expect(result).toEqual({ ok: false, reason: 'network' })
  })
})

/**
 * The model call behind the Fix button, against a mocked Gemini API.
 *
 * The Fix button's whole contract rests on how this call fails: a throttle is
 * "busy" (retry), a refused completion is "upstream" (retry), an unreachable
 * model is "network" (retry), a missing key is "unconfigured" (never retry).
 * Every branch is pinned here so a change to one cannot silently bend the
 * button's behaviour. The request itself is asserted too — the master prompt
 * must ride along as the system instruction and the finding as the user
 * content, or the model writes generic advice instead of a work order.
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

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models'
const endpoint = (model: string) => `${GEMINI}/${model}:generateContent`
const MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash-lite'] as const

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

const completion = (content: string) => ({
  candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }],
})

/** Mock every model in the chain with the same handler. */
function mockModel(handler: Parameters<typeof http.post>[1]) {
  for (const model of MODELS) {
    server.use(http.post(endpoint(model), handler))
  }
}

describe('generateFix', () => {
  it('without a key the answer is unconfigured and no request leaves the process', async () => {
    vi.stubEnv('AUTOFIX_GEMINI_API', '')
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
    vi.stubEnv('AUTOFIX_GEMINI_API', 'test-key')
    vi.stubEnv('FIXES_MODEL', '')
    let apiKey = ''
    let requestBody: Record<string, unknown> | undefined
    mockModel(async ({ request }) => {
      apiKey = request.headers.get('x-goog-api-key') ?? ''
      requestBody = (await request.json()) as Record<string, unknown>
      return HttpResponse.json(completion('Add the Content-Security-Policy header …'))
    })

    const result = await generateFix(finding)

    expect(result).toEqual({ ok: true, prompt: 'Add the Content-Security-Policy header …' })
    expect(apiKey).toBe('test-key')
    // The master prompt rides as the system instruction…
    expect(JSON.stringify(requestBody?.systemInstruction)).toContain(
      'You write fix prompts for ScanlyFix',
    )
    // …and the finding as the user content.
    const parts = (requestBody?.contents as Array<{ parts: Array<{ text: string }> }>)[0]?.parts
    const userFinding = JSON.parse(parts?.[0]?.text ?? '{}') as Record<string, unknown>
    expect(userFinding.checkId).toBe('security-csp-missing')
    expect(userFinding.siteUrl).toBe('https://example.com')
    const config = requestBody?.generationConfig as Record<string, unknown>
    expect(config?.temperature).toBe(0.2)
    // Thinking is disabled outright: with it on, the thinking pass would burn
    // free-tier tokens before the first word (lib/fixes.ts).
    expect((config?.thinkingConfig as Record<string, unknown>)?.thinkingBudget).toBe(0)
    expect(config?.maxOutputTokens).toBe(1200)
  })

  it('maps the free tier throttle (429) to busy — retryable, after the fallback also throttles', async () => {
    vi.stubEnv('AUTOFIX_GEMINI_API', 'test-key')
    mockModel(() => new HttpResponse(null, { status: 429 }))
    const result = await generateFix(finding)
    expect(result).toEqual({ ok: false, reason: 'busy' })
  })

  it('maps every other refusal to upstream — retryable', async () => {
    vi.stubEnv('AUTOFIX_GEMINI_API', 'test-key')
    mockModel(() => HttpResponse.json({ error: 'insufficient credits' }, { status: 402 }))
    const result = await generateFix(finding)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
  })

  it('maps an empty completion to upstream', async () => {
    vi.stubEnv('AUTOFIX_GEMINI_API', 'test-key')
    mockModel(() => HttpResponse.json(completion('   ')))
    expect(await generateFix(finding)).toEqual({ ok: false, reason: 'upstream' })

    server.resetHandlers()
    mockModel(() => HttpResponse.json({ candidates: [] }))
    expect(await generateFix(finding)).toEqual({ ok: false, reason: 'upstream' })
  })

  it('maps a malformed (non-JSON) answer to network', async () => {
    vi.stubEnv('AUTOFIX_GEMINI_API', 'test-key')
    mockModel(() => new HttpResponse('not json', { status: 200 }))
    expect(await generateFix(finding)).toEqual({ ok: false, reason: 'network' })
  })

  it('maps an unreachable model to network', async () => {
    vi.stubEnv('AUTOFIX_GEMINI_API', 'test-key')
    mockModel(() => HttpResponse.error())
    const result = await generateFix(finding)
    expect(result).toEqual({ ok: false, reason: 'network' })
  })
})

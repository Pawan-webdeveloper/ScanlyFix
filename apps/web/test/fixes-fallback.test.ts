import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateFix, type FixFinding } from '../lib/fixes.ts'

/**
 * The fallback chain, against a stubbed OpenRouter: the failure modes that
 * used to dead-end the Fix button (one free model 5xx-ing or throttling) now
 * walk a discovered alternate list, while the failures no model can survive
 * (a rejected key) stop immediately.
 */

const FINDING: FixFinding = {
  checkId: 'security.email.dmarc',
  category: 'security',
  severity: 'high',
  title: 'DMARC record has no rua= reporting address',
  description: 'The policy is p=reject but aggregate reports go nowhere.',
  evidence: { record: 'v=DMARC1;p=reject' },
  remediation: 'Add a rua= mailto: address.',
  siteUrl: 'https://example.com',
}

const PRIMARY = 'minimax/minimax-m3:free'

function okBody(prompt: string) {
  return {
    choices: [{ message: { content: prompt }, finish_reason: 'stop' }],
  }
}

function completionResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

const MODELS_LIST = {
  data: [
    { id: 'aaa/embed:free' },
    { id: 'bbb/alpha-chat:free' },
    { id: 'ccc/beta-chat:free' },
    { id: PRIMARY },
    { id: 'ddd/guard:free' },
  ],
}

/** A fetch stub that answers the models GET and each completions POST in order. */
function stubFetch(handlers: Array<(init: RequestInit | undefined, url: string) => Response>) {
  const calls: Array<{ url: string; init?: RequestInit; body?: unknown }> = []
  let step = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL, init?: RequestInit) => {
      const urlText = String(url)
      const handler = handlers[Math.min(step, handlers.length - 1)] ?? (() => new Response('unexpected', { status: 500 }))
      step += 1
      let body: unknown
      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      } catch {
        body = undefined
      }
      calls.push({ url: urlText, init, body })
      return Promise.resolve(handler(init, urlText))
    }),
  )
  return calls
}

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  process.env.FIXES_MODEL = PRIMARY
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('generateFix fallback chain', () => {
  it('returns unconfigured without touching the network when no key is set', async () => {
    delete process.env.OPENROUTER_API_KEY
    const calls = stubFetch([])
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: false, reason: 'unconfigured' })
    expect(calls).toHaveLength(0)
  })

  it('falls back to a discovered live model when the configured one 5xxes', async () => {
    const calls = stubFetch([
      () => completionResponse(500, { error: 'upstream down' }), // primary completion
      () => completionResponse(200, MODELS_LIST), // model discovery
      () => completionResponse(200, okBody('Add the rua= tag to the DMARC record.')), // bbb succeeds
    ])
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: true, prompt: 'Add the rua= tag to the DMARC record.' })
    // completions(primary) -> models -> completions(bbb): the embed and guard
    // ids must never be chosen as fallbacks.
    const attemptedModels = calls
      .filter((call) => call.url.includes('/chat/completions'))
      .map((call) => (call.body as { model: string }).model)
    expect(attemptedModels).toEqual([PRIMARY, 'bbb/alpha-chat:free'])
  })

  it('falls back when the free tier throttles the configured model', async () => {
    const calls = stubFetch([
      () => completionResponse(429, { error: 'rate limited' }),
      () => completionResponse(200, MODELS_LIST),
      () => completionResponse(200, okBody('Rotate the leaked credential first.')),
    ])
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: true, prompt: 'Rotate the leaked credential first.' })
    expect(calls.filter((call) => call.url.includes('/chat/completions'))).toHaveLength(2)
  })

  it('stops immediately on a key-level refusal — no model can fix a rejected key', async () => {
    const calls = stubFetch([() => completionResponse(401, { error: 'invalid key' })])
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
    // One completions call, NO discovery call: fallback would multiply the wait.
    expect(calls).toHaveLength(1)
  })

  it('reports upstream after every discovered alternate also fails', async () => {
    const calls = stubFetch([
      () => completionResponse(500, {}),
      () => completionResponse(200, MODELS_LIST),
      () => completionResponse(500, {}),
      () => completionResponse(500, {}),
    ])
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
    expect(calls.filter((call) => call.url.includes('/chat/completions'))).toHaveLength(3)
  })

  it('treats an empty completion (a reasoning model that ran out of tokens) as a fallback trigger', async () => {
    const calls = stubFetch([
      () => completionResponse(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
      () => completionResponse(200, MODELS_LIST),
      () => completionResponse(200, okBody('Write the prompt again, shorter.')),
    ])
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: true, prompt: 'Write the prompt again, shorter.' })
    expect(calls.filter((call) => call.url.includes('/chat/completions'))).toHaveLength(2)
  })

  it('sends enough completion tokens for a reasoning model to finish thinking', async () => {
    const calls = stubFetch([() => completionResponse(200, okBody('Fine.'))])
    await generateFix(FINDING)
    const body = calls[0]?.body as { max_tokens: number }
    expect(body.max_tokens).toBeGreaterThanOrEqual(1500)
  })
})

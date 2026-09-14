import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './msw/server.ts'
import { generateFix, type FixFinding } from '../lib/fixes.ts'

/**
 * The fallback chain, against a mocked Gemini API: the failure modes that
 * would dead-end the Fix button (the primary free model 5xx-ing or
 * throttling) now fall through to the fixed free alternate, while the
 * failures no model can survive (a rejected key) stop immediately.
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

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models'
const endpoint = (model: string) => `${GEMINI}/${model}:generateContent`
const PRIMARY = 'gemini-2.5-flash'
const FALLBACK = 'gemini-3.5-flash-lite'

const okBody = (prompt: string) => ({
  candidates: [{ content: { parts: [{ text: prompt }] }, finishReason: 'STOP' }],
})

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => {
  server.resetHandlers()
  vi.unstubAllEnvs()
})
afterAll(() => server.close())

/** Handlers per model, in the order the chain walks them; tracks each attempt. */
function chain(first: Parameters<typeof http.post>[1], second?: Parameters<typeof http.post>[1]) {
  const attempted: string[] = []
  const wrap =
    (model: string, handler: Parameters<typeof http.post>[1]) =>
    async (event: Parameters<Parameters<typeof http.post>[1]>[0]) => {
      attempted.push(model)
      return handler(event)
    }
  server.use(http.post(endpoint(PRIMARY), wrap(PRIMARY, first)))
  if (second) server.use(http.post(endpoint(FALLBACK), wrap(FALLBACK, second)))
  return attempted
}

beforeEach(() => {
  vi.stubEnv('AUTOFIX_GEMINI_API', 'test-key')
  vi.stubEnv('FIXES_MODEL', '')
})

describe('generateFix fallback chain', () => {
  it('returns unconfigured without touching the network when no key is set', async () => {
    vi.stubEnv('AUTOFIX_GEMINI_API', '')
    let called = false
    server.use(
      http.post(endpoint(PRIMARY), () => {
        called = true
        return HttpResponse.json(okBody('x'))
      }),
    )
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: false, reason: 'unconfigured' })
    expect(called).toBe(false)
  })

  it('falls back to the free alternate when the primary 5xxes', async () => {
    const attempted = chain(
      () => new HttpResponse(null, { status: 500 }),
      () => HttpResponse.json(okBody('Add the rua= tag to the DMARC record.')),
    )
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: true, prompt: 'Add the rua= tag to the DMARC record.' })
    expect(attempted).toEqual([PRIMARY, FALLBACK])
  })

  it('falls back when the free tier throttles the primary', async () => {
    const attempted = chain(
      () => new HttpResponse(null, { status: 429 }),
      () => HttpResponse.json(okBody('Rotate the leaked credential first.')),
    )
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: true, prompt: 'Rotate the leaked credential first.' })
    expect(attempted).toEqual([PRIMARY, FALLBACK])
  })

  it('stops immediately on a key-level refusal — no model can fix a rejected key', async () => {
    const attempted = chain(() => new HttpResponse(null, { status: 401 }))
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
    // One call, NO fallback: retrying a rejected key just multiplies the wait.
    expect(attempted).toEqual([PRIMARY])
  })

  it('reports upstream after the fallback also fails', async () => {
    const attempted = chain(
      () => new HttpResponse(null, { status: 500 }),
      () => new HttpResponse(null, { status: 500 }),
    )
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: false, reason: 'upstream' })
    expect(attempted).toEqual([PRIMARY, FALLBACK])
  })

  it('treats an empty completion as a fallback trigger', async () => {
    const attempted = chain(
      () => HttpResponse.json({ candidates: [{ content: { parts: [{ text: '' }] } }] }),
      () => HttpResponse.json(okBody('Write the prompt again, shorter.')),
    )
    const result = await generateFix(FINDING)
    expect(result).toEqual({ ok: true, prompt: 'Write the prompt again, shorter.' })
    expect(attempted).toEqual([PRIMARY, FALLBACK])
  })
})

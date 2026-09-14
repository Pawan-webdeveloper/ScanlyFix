/**
 * safe-fetch — the only way anything in this package touches the network.
 *
 * Guarantees, in order of importance:
 *   1. SSRF-safe: sockets resolve DNS through `guardedLookup`, so validation
 *      and connection are one atomic step (no rebinding window). Every redirect
 *      hop goes through the same guard.
 *   2. Bounded: hard caps on redirects, response size, decompressed size and
 *      total wall-clock time. A hostile or broken target can waste at most one
 *      timeout, never our memory.
 *   3. Honest: redirects are followed manually so the caller gets the real
 *      chain, the final URL and the final hop's raw headers.
 *
 * We use undici's `request` (not global fetch) because it hands us redirects
 * and raw set-cookie headers untouched, and lets us pin the connector.
 */

import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'
import { Agent, request, type Dispatcher } from 'undici'
import { assertSafeUrl, assertSafeRedirectUrl, guardedLookup, SsrfError } from './ssrf-guard.ts'

export class SafeFetchError extends Error {
  override name = 'SafeFetchError'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

export interface SafeFetchOptions {
  /** Whole-call budget, all hops included. */
  timeoutMs?: number
  /** Cap on the (possibly compressed) body we read; the rest is discarded. */
  maxBodyBytes?: number
  maxRedirects?: number
  /** false → return the first response as-is, 3xx included (used by the http probe). */
  followRedirects?: boolean
  headers?: Record<string, string>
  /**
   * Request method. GET by default.
   *
   * HEAD exists for the uptime probe, where a customer monitoring a large page
   * wants the status code without pulling the body every minute — theirs and
   * ours. Nothing that needs the body may ask for it: a HEAD response has none,
   * so a caller doing content inspection must send GET.
   */
  method?: 'GET' | 'HEAD'
}

export interface FetchedPage {
  requestedUrl: URL
  finalUrl: URL
  /** URLs (in order) that answered with a redirect before the final hop. */
  redirectChain: string[]
  status: number
  headers: Headers
  body: string
  /** True when the body hit `maxBodyBytes` and was cut short. */
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 5

export const SCANNER_USER_AGENT = 'ScanlyFixScanner/0.1 (+https://scanlyfix.com)'

// One shared connection pool for the whole process. The `lookup` hook is the
// SSRF guard; rejectUnauthorized stays off on purpose — a site with a broken
// certificate is exactly the kind of site we want to finish scanning and
// report on (tls.ts captures the certificate details separately).
const dispatcher: Dispatcher = new Agent({
  connect: {
    lookup: guardedLookup,
    timeout: 5_000,
    rejectUnauthorized: false,
  },
  headersTimeout: 10_000,
  bodyTimeout: 10_000,
})

/** Read at most `maxBytes` from the response, then stop pulling. */
async function readBody(
  body: Dispatcher.ResponseData['body'],
  maxBytes: number,
): Promise<{ raw: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) {
      chunks.push(buf.subarray(0, buf.length - (size - maxBytes)))
      body.destroy()
      return { raw: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(buf)
  }
  return { raw: Buffer.concat(chunks), truncated: false }
}

/**
 * We do not advertise Accept-Encoding, but some CDNs compress regardless.
 * Decompress the well-known encodings with an output cap (zip-bomb guard);
 * anything else is returned as-is — a garbled body beats a failed scan.
 */
function decodeBody(raw: Buffer, contentEncoding: string | null, maxBytes: number): Buffer {
  const encoding = contentEncoding?.split(',')[0]?.trim().toLowerCase()
  if (!encoding || encoding === 'identity') return raw
  try {
    const opts = { maxOutputLength: maxBytes }
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(raw, opts)
    if (encoding === 'deflate') return inflateSync(raw, opts)
    if (encoding === 'br') return brotliDecompressSync(raw, opts)
  } catch {
    // fall through — truncated compressed streams etc.
  }
  return raw
}

/** undici hands us header values as string | string[]; Headers normalises access. */
function toWebHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item)
    }
  }
  return headers
}

export async function safeFetch(target: URL | string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const requestedUrl = new URL(target)
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    followRedirects = true,
  } = options

  const signal = AbortSignal.timeout(timeoutMs)
  const redirectChain: string[] = []
  let current = new URL(requestedUrl)

  // Hop loop: each iteration is one request; redirects re-enter with the new URL.
  for (;;) {
    assertSafeUrl(current)

    let response: Dispatcher.ResponseData
    try {
      response = await request(current, {
        method: options.method ?? 'GET',
        dispatcher,
        signal,
        headers: {
          'user-agent': SCANNER_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          // Exactly what decodeBody can undo. Asking matters twice over: a
          // server only sets Content-Encoding when compression was requested,
          // so without this the compression check could never observe one — and
          // it means every scan pulls a fraction of the bytes off somebody
          // else's server, which is the polite way to visit uninvited.
          'accept-encoding': 'gzip, deflate, br',
          ...options.headers,
        },
      })
    } catch (error) {
      if (error instanceof SsrfError) throw error
      // undici wraps connector errors; surface an SsrfError if ours is inside.
      if (error instanceof Error && error.cause instanceof SsrfError) throw error.cause
      throw new SafeFetchError(`Request to ${current.href} failed: ${describeError(error)}`, { cause: error })
    }

    const { statusCode } = response
    const location = firstHeader(response.headers.location)

    if (followRedirects && statusCode >= 300 && statusCode < 400 && location) {
      await response.body.dump() // release the connection before the next hop
      if (redirectChain.length >= maxRedirects) {
        throw new SafeFetchError(`Too many redirects (>${maxRedirects}) starting from ${requestedUrl.href}`)
      }
      redirectChain.push(current.href)
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new SafeFetchError(`Redirect from ${current.href} has an invalid Location: ${location}`)
      }
      // SSRF guard: validate redirect target before making the next request.
      // Blocks protocol downgrade (https→http), private IPs, and bad schemes.
      assertSafeRedirectUrl(current, next)
      current = next
      continue
    }

    const headers = toWebHeaders(response.headers)

    // The body phase fails independently of the request phase: a target can
    // send clean headers and then reset mid-body, stall past bodyTimeout, or
    // trip the overall deadline. All of it must surface as SafeFetchError —
    // callers (CLI today, the web worker later) rely on that contract.
    let raw: Buffer
    let truncated: boolean
    let decoded: Buffer
    try {
      ;({ raw, truncated } = await readBody(response.body, maxBodyBytes))
      decoded = decodeBody(raw, headers.get('content-encoding'), maxBodyBytes)
    } catch (error) {
      if (error instanceof SsrfError) throw error
      throw new SafeFetchError(`Reading body from ${current.href} failed: ${describeError(error)}`, {
        cause: error,
      })
    }

    return {
      requestedUrl,
      finalUrl: current,
      redirectChain,
      status: statusCode,
      headers,
      // Assume UTF-8. Legacy charsets render as mojibake but header/structure
      // checks still work; charset sniffing is not worth its weight in Phase 0.
      body: decoded.toString('utf8'),
      truncated,
    }
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // AggregateError from parallel connect attempts: report the first real cause.
    if (error instanceof AggregateError && error.errors[0] instanceof Error) {
      return error.errors[0].message
    }
    return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message
  }
  return String(error)
}

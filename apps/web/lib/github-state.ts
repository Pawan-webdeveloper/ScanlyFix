/**
 * Stateless, signed install state for the GitHub App flow.
 *
 * The callback used to answer "who clicked Install?" from the session cookie,
 * which is exactly the thing a cross-site redirect back from github.com can
 * drop. Instead, the connect URL now carries a signed `state` param that GitHub
 * round-trips unchanged: HMAC(user id + nonce + expiry). The callback verifies
 * it and knows the owner without any session, so the installation row can be
 * written before the app ever asks whether the browser is signed in.
 *
 * Pure and dependency-free on purpose: the secret is passed in by the caller
 * (read once through serverEnv), so the crypto is unit-testable like
 * lib/repo-cap.ts.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

interface InstallStatePayload {
  /** Application user id (users.id), the owner of the install. */
  u: string
  /** Nonce so two links for the same user never produce identical tokens. */
  n: string
  /** Expiry, seconds since epoch. */
  e: number
}

const TTL_SECONDS = 15 * 60

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/**
 * Sign the install state. Returns null for an empty secret so callers degrade
 * to the session-based flow rather than shipping an unsigned token.
 */
export function signInstallState(secret: string, userId: string, now = Date.now()): string | null {
  if (!secret) return null
  const payload: InstallStatePayload = {
    u: userId,
    n: randomBytes(12).toString('base64url'),
    e: Math.floor(now / 1000) + TTL_SECONDS,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${hmac(secret, body)}`
}

/**
 * Verify the install state. Null on any failure: wrong signature, malformed
 * payload, missing fields, or an expired token.
 */
export function verifyInstallState(secret: string, state: string, now = Date.now()): { userId: string } | null {
  if (!secret) return null
  const dot = state.lastIndexOf('.')
  if (dot <= 0) return null

  const body = state.slice(0, dot)
  const signature = state.slice(dot + 1)
  const expected = hmac(secret, body)

  if (expected.length !== signature.length) return null
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null

  let payload: InstallStatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as InstallStatePayload
  } catch {
    return null
  }

  if (typeof payload?.u !== 'string' || typeof payload?.e !== 'number') return null
  if (payload.e < Math.floor(now / 1000)) return null

  return { userId: payload.u }
}

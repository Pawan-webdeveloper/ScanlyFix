import { describe, expect, it } from 'vitest'
import { signInstallState, verifyInstallState } from '@/lib/github-state.ts'

const SECRET = 'test-secret'
const NOW = 1_000_000_000_000

describe('signInstallState', () => {
  it('returns null for an empty secret so callers can degrade gracefully', () => {
    expect(signInstallState('', 'user-1', NOW)).toBeNull()
  })
})

describe('verifyInstallState', () => {
  it('round-trips a signed state back to the user id', () => {
    const state = signInstallState(SECRET, 'user-1', NOW)
    expect(state).not.toBeNull()
    expect(verifyInstallState(SECRET, state!, NOW)).toEqual({ userId: 'user-1' })
  })

  it('rejects a payload whose signature was tampered with', () => {
    const state = signInstallState(SECRET, 'user-1', NOW)!
    const [body] = state.split('.')
    expect(verifyInstallState(SECRET, `${body}.${'a'.repeat(43)}`, NOW)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const state = signInstallState(SECRET, 'user-1', NOW)!
    expect(verifyInstallState('other-secret', state, NOW)).toBeNull()
  })

  it('rejects an expired token', () => {
    const state = signInstallState(SECRET, 'user-1', NOW)!
    const pastTtl = NOW + 16 * 60 * 1000
    expect(verifyInstallState(SECRET, state, pastTtl)).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(verifyInstallState(SECRET, 'not-a-token', NOW)).toBeNull()
    expect(verifyInstallState(SECRET, '', NOW)).toBeNull()
  })
})

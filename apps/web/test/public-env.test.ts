/**
 * The public env readers, which are the only thing standing between a typo in
 * a deployment's variables and a sign-in that fails with no visible reason.
 *
 * The regression: the production build inlined a publishable key ending in a
 * stray backslash (`sb_publishable_…U\`), Supabase answered 401 "Invalid API
 * key" to every call, and Google and GitHub sign-in both died on a generic
 * error. `required` saw a non-empty string and passed it straight through.
 *
 * Values are read at call time, so each test stubs only the variable it is
 * about; `unstubAllEnvs` restores the originals from the loaded `.env`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicEnv } from '../lib/public-env.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

function setKey(value: string) {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', value)
}

describe('publicEnv.supabaseAnonKey', () => {
  it('drops a trailing backslash a shell paste left on the key', () => {
    setKey('sb_publishable_ntJKwmQ1LPJANShe5NwYwQ_NuXWdu0U\\')

    expect(publicEnv.supabaseAnonKey()).toBe('sb_publishable_ntJKwmQ1LPJANShe5NwYwQ_NuXWdu0U')
  })

  it('trims surrounding whitespace', () => {
    setKey('  sb_publishable_abc  ')

    expect(publicEnv.supabaseAnonKey()).toBe('sb_publishable_abc')
  })

  it('strips one matching pair of surrounding quotes', () => {
    setKey('"sb_publishable_abc"')

    expect(publicEnv.supabaseAnonKey()).toBe('sb_publishable_abc')
  })

  it('returns a genuine key untouched', () => {
    setKey('sb_publishable_ntJKwmQ1LPJANShe5NwYwQ_NuXWdu0U')

    expect(publicEnv.supabaseAnonKey()).toBe('sb_publishable_ntJKwmQ1LPJANShe5NwYwQ_NuXWdu0U')
  })
})

describe('publicEnv.appUrl', () => {
  it('trims a trailing space off the site URL, which would break an allowlist match', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    vi.stubEnv('NEXT_PUBLIC_VERCEL_URL', '')
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '')
    vi.stubEnv('VERCEL_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://scanlyfix.com ')

    expect(publicEnv.appUrl()).toBe('https://scanlyfix.com')
  })
})

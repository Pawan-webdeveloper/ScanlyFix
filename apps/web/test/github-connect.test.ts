import { describe, expect, it } from 'vitest'
import { buildInstallUrl, requestOrigin } from '@/lib/github-connect.ts'

function headersWith(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('requestOrigin', () => {
  it('uses the plain host header for a directly-served origin', () => {
    expect(requestOrigin(headersWith({ host: 'localhost:3000' }), 'https://scanlyfix.com')).toBe(
      'http://localhost:3000',
    )
  })

  it('honours the forwarded protocol a TLS-terminating proxy provides', () => {
    const headers = headersWith({ host: 'scanlyfix.com', 'x-forwarded-proto': 'https' })
    expect(requestOrigin(headers, 'http://wrong')).toBe('https://scanlyfix.com')
  })

  it('takes the client-facing host from a multi-proxy x-forwarded-host chain', () => {
    const headers = headersWith({
      host: 'internal-pod.scanlyfix.svc',
      'x-forwarded-host': 'scanlyfix.com, edge.internal',
      'x-forwarded-proto': 'https,http',
    })
    expect(requestOrigin(headers, 'http://wrong')).toBe('https://scanlyfix.com')
  })

  it('falls back to the deployment URL when no host header exists (prerender)', () => {
    expect(requestOrigin(new Headers(), 'https://scanlyfix.com')).toBe('https://scanlyfix.com')
  })

  it('prefers a forwarded host the proxy saw over the internal host header', () => {
    const headers = headersWith({ host: 'internal:8080', 'x-forwarded-host': 'scanlyfix.com' })
    expect(requestOrigin(headers, 'http://wrong')).toBe('http://scanlyfix.com')
  })
})

describe('buildInstallUrl', () => {
  it('sends the post-install redirect back to the origin the button was clicked on', () => {
    const url = new URL(buildInstallUrl('scanlyfix', 'http://localhost:3000'))
    expect(url.origin).toBe('https://github.com')
    expect(url.pathname).toBe('/apps/scanlyfix/installations/new')
    const redirect = url.searchParams.get('redirect_url')
    expect(redirect).toBe('http://localhost:3000/api/github/callback?next=%2Ffeed')
  })

  it('trims a trailing slash so the callback path is never doubled', () => {
    const url = new URL(buildInstallUrl('scanlyfix', 'https://scanlyfix.com/'))
    expect(url.searchParams.get('redirect_url')).toBe('https://scanlyfix.com/api/github/callback?next=%2Ffeed')
  })

  it('without an origin, hands GitHub the bare install URL rather than a wrong redirect', () => {
    expect(buildInstallUrl('scanlyfix', '')).toBe('https://github.com/apps/scanlyfix/installations/new')
  })
})

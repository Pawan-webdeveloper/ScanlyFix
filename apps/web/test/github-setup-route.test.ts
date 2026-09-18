/**
 * The GitHub App Setup URL route.
 *
 * GitHub sends the browser to the App's configured Setup URL after an install
 * or an update, and it IGNORES the `redirect_url` the Connect button built. The
 * Setup URL is `/api/github/setup`; until this route existed that request hit
 * the 404 page and the install was never recorded — the "Connect GitHub" button
 * that never goes away.
 *
 * The route is an alias for /api/github/callback, so the only thing to lock
 * down is that GitHub's parameters survive the hand-over.
 */

import { describe, expect, it } from 'vitest'

const { GET } = await import('../app/api/github/setup/route.ts')

async function locationFor(url: string): Promise<string> {
  const response = await GET(new Request(url))
  return response.headers.get('location') ?? ''
}

describe('/api/github/setup', () => {
  it('forwards an install to the callback handler, params intact', async () => {
    const location = await locationFor(
      'https://scanlyfix.com/api/github/setup?installation_id=158478164&setup_action=install&state=body.sig',
    )

    expect(location).toBe(
      'https://scanlyfix.com/api/github/callback?installation_id=158478164&setup_action=install&state=body.sig',
    )
  })

  it('forwards the update case the App sends with "Redirect on update"', async () => {
    const location = await locationFor(
      'https://scanlyfix.com/api/github/setup?installation_id=158478164&setup_action=update&state=body.sig',
    )

    expect(location).toBe(
      'https://scanlyfix.com/api/github/callback?installation_id=158478164&setup_action=update&state=body.sig',
    )
  })

  it('forwards an org approval request, which carries no installation id', async () => {
    const location = await locationFor('https://scanlyfix.com/api/github/setup?setup_action=request')

    expect(location).toBe('https://scanlyfix.com/api/github/callback?setup_action=request')
  })

  it('carries an OAuth code through, so the callback can warn about the setting', async () => {
    const location = await locationFor(
      'https://scanlyfix.com/api/github/setup?installation_id=1&setup_action=install&code=abc',
    )

    expect(location).toBe(
      'https://scanlyfix.com/api/github/callback?installation_id=1&setup_action=install&code=abc',
    )
  })
})

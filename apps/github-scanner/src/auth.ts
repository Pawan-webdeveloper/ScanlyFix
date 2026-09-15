/**
 * GitHub App auth for the worker.
 *
 * Mirrors apps/web/lib/github-app.ts, minus the web-only server-only marker.
 * The worker holds the App's private key so it can mint a short-lived
 * installation token itself — the web app sends only `installationId`, never a
 * token, so a stale token cannot ride along in the queue message.
 */

import { createSign } from 'node:crypto'

const GITHUB_APP_ID = process.env['GITHUB_APP_ID'] ?? ''
const GITHUB_APP_PRIVATE_KEY = process.env['GITHUB_APP_PRIVATE_KEY'] ?? ''

/** True when both App credentials are present; the process refuses to start without them. */
export function githubConfigured(): boolean {
  return Boolean(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY)
}

function pem(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key
}

function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: GITHUB_APP_ID }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signingInput = `${headerB64}.${payloadB64}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  const signature = signer.sign(pem(GITHUB_APP_PRIVATE_KEY), 'base64url')
  return `${signingInput}.${signature}`
}

/** Exchange the App JWT for a short-lived installation access token. */
export async function mintInstallationToken(installationId: number): Promise<string> {
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${signAppJwt()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'scanlyfix-github-scanner',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Could not mint installation token (${res.status}): ${body}`)
  }
  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error('GitHub installation token response missing token')
  return data.token
}

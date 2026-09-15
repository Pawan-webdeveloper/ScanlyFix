/**
 * The GitHub App install callback, where the three setup_action values diverge:
 *
 *   - `install`  → record the installation, land on the feed's repositories
 *   - `update`   → same idempotent record, but with a distinct "updated" notice
 *   - `request`  → org approval pending; there is no installation yet, so the
 *                  route must NOT fall into the "missing installation" error
 *
 * The `request` case is the regression these lock down: it used to carry no
 * installation_id and bounced into the missing-installation error path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signInstallState } from '@/lib/github-state.ts'

const SECRET = 'test-secret'

const getViewer = vi.fn()
const getInstallationAccount = vi.fn()
const listInstallationRepos = vi.fn()
const upsertInstallation = vi.fn()
const listReposForViewer = vi.fn()
const upsertRepo = vi.fn()
const deleteOtherReposForUser = vi.fn()

vi.mock('@/lib/authz.ts', () => ({ getViewer }))
vi.mock('@/lib/env.ts', () => ({ serverEnv: { githubStateSecret: SECRET } }))
vi.mock('@/lib/github-app.ts', () => ({ getInstallationAccount, listInstallationRepos }))
vi.mock('@scanlyfix/db', () => ({
  upsertInstallation,
  listReposForViewer,
  upsertRepo,
  deleteOtherReposForUser,
}))

const { GET } = await import('../app/api/github/callback/route.ts')

async function locationFor(url: string): Promise<string> {
  const response = await GET(new Request(url))
  return response.headers.get('location') ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  getViewer.mockResolvedValue({ kind: 'user', userId: 'user-1' })
  getInstallationAccount.mockResolvedValue({ id: 1, login: 'acme', type: 'Organization' })
  upsertInstallation.mockResolvedValue({ id: 'inst-1', status: 'active' })
  listInstallationRepos.mockResolvedValue([])
  listReposForViewer.mockResolvedValue([])
})

describe('/api/github/callback', () => {
  it('treats setup_action=request as pending approval, not a missing installation', async () => {
    const location = await locationFor(
      'https://scanlyfix.com/api/github/callback?setup_action=request',
    )

    expect(location).toBe('https://scanlyfix.com/feed?notice=github-request-pending')
    expect(getInstallationAccount).not.toHaveBeenCalled()
    expect(upsertInstallation).not.toHaveBeenCalled()
  })

  it('lands an install on the repositories anchor', async () => {
    const state = signInstallState(SECRET, 'user-1')!
    const location = await locationFor(
      `https://scanlyfix.com/api/github/callback?installation_id=123&setup_action=install&state=${state}`,
    )

    expect(upsertInstallation).toHaveBeenCalledTimes(1)
    expect(location).toBe('https://scanlyfix.com/feed#repositories')
  })

  it('lands an update on a distinct "updated" notice', async () => {
    const state = signInstallState(SECRET, 'user-1')!
    const location = await locationFor(
      `https://scanlyfix.com/api/github/callback?installation_id=123&setup_action=update&state=${state}`,
    )

    expect(upsertInstallation).toHaveBeenCalledTimes(1)
    expect(location).toBe('https://scanlyfix.com/feed?notice=github-updated#repositories')
  })
})

/**
 * The GitHub webhook's suspend/unsuspend handling. These events carry only an
 * installation id — never an application user — so the handler must update the
 * row by GitHub's numeric id without resolving a Viewer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const verifyWebhookSignature = vi.fn()
const listInstallationRepos = vi.fn()
const setInstallationStatusByGithubId = vi.fn()

vi.mock('@/lib/authz.ts', () => ({ getViewer: vi.fn() }))
vi.mock('@/lib/env.ts', () => ({ serverEnv: { githubWebhookConfigured: true } }))
vi.mock('@/lib/github-app.ts', () => ({ verifyWebhookSignature, listInstallationRepos }))
vi.mock('@scanlyfix/db', () => ({
  deleteInstallationByGithubId: vi.fn(),
  deleteOtherReposForUser: vi.fn(),
  deleteReposByGithubIds: vi.fn(),
  getInstallationByGithubId: vi.fn(),
  listReposForViewer: vi.fn(),
  setInstallationStatusByGithubId,
  upsertInstallation: vi.fn(),
  upsertRepo: vi.fn(),
}))

const { POST } = await import('../app/api/webhooks/github/route.ts')

function webhookRequest(event: string, body: unknown, signature = 'sha256=abc'): Request {
  return new Request('https://scanlyfix.com/api/webhooks/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': signature,
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyWebhookSignature.mockResolvedValue(true)
})

describe('/api/webhooks/github suspend/unsuspend', () => {
  it('marks a suspended installation as suspended by GitHub id', async () => {
    await POST(webhookRequest('installation.suspend', { installation: { id: 42 } }))

    expect(setInstallationStatusByGithubId).toHaveBeenCalledWith(42, 'suspended')
  })

  it('marks an unsuspended installation active again', async () => {
    await POST(webhookRequest('installation.unsuspend', { installation: { id: 42 } }))

    expect(setInstallationStatusByGithubId).toHaveBeenCalledWith(42, 'active')
  })

  it('rejects a tampered signature before touching the database', async () => {
    verifyWebhookSignature.mockResolvedValue(false)

    const response = await POST(webhookRequest('installation.suspend', { installation: { id: 42 } }))

    expect(response.status).toBe(400)
    expect(setInstallationStatusByGithubId).not.toHaveBeenCalled()
  })
})

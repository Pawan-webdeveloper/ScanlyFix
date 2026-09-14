import { NextResponse } from 'next/server'
import {
  deleteInstallationByGithubId,
  deleteOtherReposForUser,
  deleteReposByGithubIds,
  getInstallationByGithubId,
  listReposForViewer,
  upsertInstallation,
  upsertRepo,
  type Viewer,
} from '@scanlyfix/db'
import { listInstallationRepos, verifyWebhookSignature, type InstallationRepo } from '@/lib/github-app.ts'
import { chooseConnectedRepo } from '@/lib/repo-cap.ts'
import { getViewer } from '@/lib/authz.ts'
import { serverEnv } from '@/lib/env.ts'

export const runtime = 'nodejs'

interface GithubAccount {
  id: number
  login: string
  type: string
}

interface InstallationEvent {
  installation?: {
    id: number
    account?: GithubAccount | null
    repositories?: InstallationRepo[]
  }
  repositories?: InstallationRepo[]
  repositories_removed?: InstallationRepo[]
}

interface WebhookPayload {
  action?: string
  installation?: InstallationEvent['installation']
  repositories?: InstallationRepo[]
  repositories_removed?: InstallationRepo[]
}

export async function POST(request: Request) {
  if (!serverEnv.githubWebhookConfigured) {
    console.error('[webhooks/github] not configured — dropping event')
    return NextResponse.json({ received: true })
  }

  const signature = request.headers.get('x-hub-signature-256')
  const body = await request.text()
  if (!(await verifyWebhookSignature(body, signature))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  let event: WebhookPayload
  try {
    event = JSON.parse(body) as WebhookPayload
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const eventName = request.headers.get('x-github-event') ?? ''
  try {
    switch (eventName) {
      case 'installation.created':
      case 'installation.repositories.added':
        await handleInstall(event)
        break
      case 'installation.deleted':
        await handleDelete(event)
        break
      case 'installation.repositories.removed':
        await handleRepoRemoved(event)
        break
      default:
        return NextResponse.json({ received: true })
    }
  } catch (error) {
    console.error(`[webhooks/github] could not apply ${eventName}`, error)
    return NextResponse.json({ error: 'Could not process event' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

async function handleInstall(event: WebhookPayload): Promise<void> {
  const installation = event.installation
  if (!installation?.id || !installation.account) return

  const viewer = await resolveViewerForInstallation(installation.id, installation.account)
  if (!viewer) {
    console.warn('[webhooks/github] no application user owns installation', installation.id)
    return
  }

  const upserted = await upsertInstallation(viewer, {
    installationId: installation.id,
    accountLogin: installation.account.login,
    accountType: installation.account.type,
  })
  if (!upserted) return

  /*
   * Always list from GitHub rather than trusting the event payload: the
   * repositories array on installation_repositories.added can be a partial
   * list, and the one-repo cap decision below needs the complete granted set.
   */
  let repos: InstallationRepo[]
  try {
    repos = await listInstallationRepos(installation.id)
  } catch (error) {
    console.error('[webhooks/github] could not list installation repos', error)
    return
  }

  // One repo per account, the same rule the GitHub callback applies.
  const existing = await listReposForViewer(viewer)
  const granted = repos.map((repo) => ({ ...repo, githubId: repo.id }))
  const chosen = chooseConnectedRepo(existing, granted)
  if (!chosen) return

  const alreadyStored = existing.find((repo) => repo.githubId === chosen.repo.id)
  const row = alreadyStored ?? (await upsertRepo({
    installationId: upserted.id,
    owner: chosen.repo.owner.login,
    name: chosen.repo.name,
    fullName: chosen.repo.full_name,
    defaultBranch: chosen.repo.default_branch,
    private: chosen.repo.private,
    githubId: chosen.repo.id,
  }))
  if (row) await deleteOtherReposForUser(viewer, row.id)
}

async function handleDelete(event: WebhookPayload): Promise<void> {
  const installationId = event.installation?.id
  if (!installationId) return
  await deleteInstallationByGithubId(installationId)
}

async function handleRepoRemoved(event: WebhookPayload): Promise<void> {
  const installationId = event.installation?.id
  if (!installationId) return
  const row = await getInstallationByGithubId(installationId)
  if (!row) return
  const removed = event.repositories_removed ?? []
  await deleteReposByGithubIds(
    row.id,
    removed.map((repo) => repo.id),
  )
}

async function resolveViewerForInstallation(
  installationId: number,
  account: GithubAccount,
): Promise<Viewer | null> {
  const existing = await getInstallationByGithubId(installationId)
  if (existing) {
    return { kind: 'user', userId: existing.userId }
  }
  const viewer = await getViewer()
  if (viewer.kind !== 'user') return null
  return viewer
}

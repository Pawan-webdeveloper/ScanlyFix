import { NextResponse } from 'next/server'
import { getViewer } from '@/lib/authz.ts'
import { getInstallationAccount, listInstallationRepos } from '@/lib/github-app.ts'
import { upsertInstallation, upsertRepo } from '@scanlyfix/db'

export const runtime = 'nodejs'

function fail(error: string, status: number, origin: string, next: string) {
  return NextResponse.redirect(new URL(`/feed?error=${encodeURIComponent(error)}`, origin))
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const installationIdRaw = url.searchParams.get('installation_id')
  const setupAction = url.searchParams.get('setup_action')
  const next = url.searchParams.get('next') ?? '/feed'

  if (!installationIdRaw) return fail('missing-installation', 400, url.origin, next)

  // An OAuth `code` beside installation_id means the GitHub App still has
  // "Request user authorization (OAuth) during installation" enabled. For
  // that flow GitHub ignores the redirect_url the Connect button built and
  // sends the user to the app's FIRST configured Callback URL instead — which
  // strands every origin that isn't listed first. The app never uses user
  // tokens (installation tokens only), so that setting should stay off.
  if (url.searchParams.get('code')) {
    console.warn(
      '[github/callback] OAuth code present: the GitHub App requests user authorization during installation, so GitHub ignored redirect_url and used its first configured Callback URL.',
    )
  }

  const installationId = Number(installationIdRaw)
  if (!Number.isFinite(installationId)) return fail('invalid-installation', 400, url.origin, next)

  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    const login = new URL('/login', url.origin)
    login.searchParams.set('next', next)
    login.searchParams.set('error', 'github-connect-requires-signin')
    return NextResponse.redirect(login)
  }

  try {
    const account = await getInstallationAccount(installationId)
    const installation = await upsertInstallation(viewer, {
      installationId,
      accountLogin: account.login,
      accountType: account.type,
    })
    if (!installation) throw new Error('Could not record installation')

    const repos = await listInstallationRepos(installationId)
    for (const repo of repos) {
      await upsertRepo({
        installationId: installation.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        private: repo.private,
        githubId: repo.id,
      })
    }

    const destination = new URL('/feed#repositories', url.origin)
    if (setupAction) destination.searchParams.set('setup_action', setupAction)
    return NextResponse.redirect(destination)
  } catch (error) {
    console.error('[github/callback] could not finish install', error)
    return fail('github-install-failed', 500, url.origin, next)
  }
}

/**
 * The connection apps: one component family, two surfaces.
 *
 * `ConnectAppsHub` is the Feed's hub — every provider card in one grid, fed
 * the data the feed page has already loaded. `ConnectApps` is the dashboard's
 * bottom section — the same cards in the same order (GitHub, Supabase, then
 * the rest), self-fetching because the overview page does not otherwise load
 * connection data. Both render from PROVIDER_APPS in lib/connection-providers
 * .ts, so the order a person learns on one page is the order they find on the
 * other, and adding a provider there makes it appear here with no copy step.
 *
 * The cards are state projections, never config projections: connected /
 * not connected / coming soon, plus a count where one exists. No token, no
 * vault pointer, no URL the user did not already type — the same non-secret
 * discipline McpConnectionStatus carries in the integration plan (§1.4).
 */

import Link from 'next/link'
import { headers } from 'next/headers'
import {
  listConnectionsForViewer,
  listInstallationsForViewer,
  listReposForViewer,
  type Connection,
  type GithubInstallation,
  type Viewer,
} from '@scanlyfix/db'
import { serverEnv } from '@/lib/env.ts'
import { buildInstallUrl, requestOrigin } from '@/lib/github-connect.ts'
import { PROVIDER_APPS, type ConnectionAppProvider, type ProviderApp } from '@/lib/connection-providers.ts'
import { GitHubMark, SupabaseMark, GitLabMark, CloudflareMark } from './provider-marks.tsx'

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

function ProviderMark({ provider, size = 16 }: { provider: ConnectionAppProvider; size?: number }) {
  switch (provider) {
    case 'github':
      return <GitHubMark size={size} />
    case 'supabase':
      return <SupabaseMark size={size} />
    case 'gitlab':
      return <GitLabMark size={size} />
    case 'cloudflare':
      return <CloudflareMark size={size} />
  }
}

/** What one card knows how to say about its provider. */
interface AppState {
  /** The connection line under the label. */
  detail: string
  /** The primary action, when there is one. */
  cta?: { label: string; href: string }
  /** The GitHub App install URL opens off-site; a plain anchor is correct. */
  external?: boolean
  /** Shown instead of a CTA when the provider is not actionable yet. */
  note?: string
  /** Coming-soon cards render quiet, so they read as queued, not broken. */
  muted?: boolean
}

const CARD_BASE = 'rounded-xl border border-c-line/60 bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]'

/**
 * One provider card. The feed and dashboard variants share the whole layout
 * and differ only in the mark chip's shape and the CTA's pill, matching what
 * each page already draws — the feed rounds its chips fully, the overview
 * squares them like the Repositories rows.
 */
function AppCard({
  app,
  state,
  variant,
}: {
  app: ProviderApp
  state: AppState
  variant: 'feed' | 'dashboard'
}) {
  const chip =
    variant === 'feed'
      ? 'grid h-10 w-10 shrink-0 place-items-center rounded-full bg-c-soft text-c-muted'
      : 'grid h-9 w-9 shrink-0 place-items-center rounded-md border border-c-line bg-c-soft text-c-muted'
  const ctaClass =
    variant === 'feed'
      ? 'self-start rounded-full bg-c-soft px-4 py-1.5 text-[12px] font-medium text-c-muted transition-colors hover:bg-c-line hover:text-c-ink'
      : 'self-start rounded-md border border-c-line bg-c-card px-3 py-1.5 text-[12px] font-medium text-c-ink transition-colors hover:bg-c-soft'

  return (
    <div
      data-reveal-item=""
      className={`${variant === 'feed' ? `${CARD_BASE} p-5` : 'rounded-lg border border-c-line bg-c-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]'} flex h-full flex-col gap-3`}
    >
      <div className="flex items-center gap-3">
        <span className={chip}>
          <ProviderMark provider={app.provider} />
        </span>
        <div className="min-w-0">
          <p className={`text-[14px] font-medium ${state.muted ? 'text-c-muted' : 'text-c-ink'}`}>
            {app.label}
          </p>
          <p className="truncate text-[12px] text-c-muted">{state.detail}</p>
        </div>
      </div>

      <p className="text-[13px] leading-relaxed text-c-muted text-pretty">{app.blurb}</p>

      <div className="mt-auto">
        {state.cta ? (
          state.external ? (
            <a href={state.cta.href} data-press="" className={ctaClass}>
              {state.cta.label}
            </a>
          ) : (
            <Link href={state.cta.href} className={ctaClass}>
              {state.cta.label}
            </Link>
          )
        ) : state.note ? (
          <p className="text-[12px] text-c-muted">{state.note}</p>
        ) : null}
      </div>
    </div>
  )
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

/* -------------------------------------------------------------------------- */
/* GitHub state — shared by both surfaces                                     */
/* -------------------------------------------------------------------------- */

function githubNotConnectedState(githubUrl: string | null): AppState {
  return githubUrl
    ? { detail: 'Not connected', cta: { label: 'Connect GitHub', href: githubUrl }, external: true }
    : { detail: 'Not configured', note: 'Ask your admin to configure the GitHub App to enable it.' }
}

function gitlabState(): AppState {
  return { detail: 'Coming soon', note: 'Planned — read-api token checks.', muted: true }
}

function cloudflareState(): AppState {
  return { detail: 'Coming soon', note: 'Planned — read-only zone and DNS checks.', muted: true }
}

function stateFor(provider: ConnectionAppProvider, githubUrl: string | null, installations: GithubInstallation[], connections: Connection[], repoCount?: number): AppState {
  switch (provider) {
    case 'github':
      if (installations.length === 0) return githubNotConnectedState(githubUrl)
      return {
        detail:
          repoCount === undefined
            ? `Connected · ${plural(installations.length, 'account', 'accounts')}`
            : `Connected · ${plural(repoCount, 'repository', 'repositories')}`,
        cta:
          repoCount === undefined && githubUrl
            ? { label: '+ Connect another', href: githubUrl }
            : { label: 'Manage on Feed', href: '/feed#connect' },
        external: repoCount === undefined && !!githubUrl,
      }
    case 'supabase': {
      const n = connections.filter((c) => c.provider === 'supabase').length
      return {
        detail: n === 0 ? 'Not connected' : `Connected · ${plural(n, 'project', 'projects')}`,
        cta:
          n === 0
            ? { label: 'Connect Supabase', href: '/feed#connect' }
            : { label: 'Manage on Feed', href: '/feed#connect' },
      }
    }
    case 'gitlab':
      return gitlabState()
    case 'cloudflare':
      return cloudflareState()
  }
}

/* -------------------------------------------------------------------------- */
/* Feed hub                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Feed's "Connect your apps" grid. The feed page has already loaded the
 * installations, connections and install URL, so they arrive as props and the
 * hub adds no queries to the page.
 */
export function ConnectAppsHub({
  installations,
  connections,
  githubUrl,
}: {
  installations: GithubInstallation[]
  connections: Connection[]
  githubUrl: string | null
}) {
  return (
    <section id="connect" data-reveal="" className="scroll-mt-20">
      <div data-reveal-item="" className="mb-4 flex items-end justify-between gap-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-c-muted">
          Connect your apps
        </h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {PROVIDER_APPS.map((app) => (
          <AppCard
            key={app.provider}
            app={app}
            state={stateFor(app.provider, githubUrl, installations, connections)}
            variant="feed"
          />
        ))}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Dashboard bottom section                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The overview's closing section: the inventory's inventory. GitHub's CTA
 * goes straight to the install URL (the origin-echo rule lives in
 * buildInstallUrl); every other provider's form lives on the Feed, so its CTA
 * points there rather than duplicating the flow.
 */
export async function ConnectApps({ viewer }: { viewer: Viewer }) {
  const [installations, connections, repos] = await Promise.all([
    listInstallationsForViewer(viewer),
    listConnectionsForViewer(viewer),
    listReposForViewer(viewer),
  ])

  const githubUrl = serverEnv.githubConfigured
    ? buildInstallUrl(
        serverEnv.githubAppSlug,
        requestOrigin(await headers(), process.env['NEXT_PUBLIC_APP_URL'] ?? ''),
      )
    : null

  return (
    <section id="connect" data-reveal="" className="scroll-mt-20">
      <div data-reveal-item="" className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-sm font-medium text-c-ink">Connect your apps</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {PROVIDER_APPS.map((app) => (
          <AppCard
            key={app.provider}
            app={app}
            state={stateFor(app.provider, githubUrl, installations, connections, repos.length)}
            variant="dashboard"
          />
        ))}
      </div>
    </section>
  )
}

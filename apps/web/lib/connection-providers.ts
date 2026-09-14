/**
 * The connection apps, in one place and one order.
 *
 * The feed's hub and the dashboard's bottom section both render from this
 * array, so the order a person learns on one page is the order they find on
 * the other. It is the single answer to "what can I connect?" — adding a
 * provider here makes it appear in both surfaces, and nowhere is the list
 * hand-copied.
 *
 * Client-safe on purpose (no `server-only`, no env): the dashboard renders
 * this on the server and the feed's islands may import the same copy for
 * labels. The provider strings mirror `connectionProviderEnum` in
 * `packages/db/src/schema.ts` plus `github`, whose grant lives in
 * `github_installations` and must never be added there (see the OAuth↔MCP
 * integration plan §1.1 for why).
 */

export type ConnectionAppProvider = 'github' | 'supabase' | 'gitlab' | 'cloudflare'

export interface ProviderApp {
  provider: ConnectionAppProvider
  label: string
  /** One sentence under the label — what connecting grants, not marketing. */
  blurb: string
  /** The card's primary action, when the flow exists. */
  connectCta: string
  /**
   * False while the connect flow is still a build step. The card renders its
   * "Coming soon" state so the model is visible before the flow is.
   */
  connectable: boolean
}

/** Render order everywhere: GitHub first, Supabase second, then the rest. */
export const PROVIDER_APPS: readonly ProviderApp[] = [
  {
    provider: 'github',
    label: 'GitHub',
    blurb:
      'Install the ScanlyFix GitHub App to scan your repositories for secrets, vulnerable dependencies, and workflow misconfigurations.',
    connectCta: 'Connect GitHub',
    connectable: true,
  },
  {
    provider: 'supabase',
    label: 'Supabase',
    blurb:
      'Run the Level-1 publishable-key checks against a project — only what the key your own frontend already ships to every visitor can see.',
    connectCta: 'Connect Supabase',
    connectable: true,
  },
  {
    provider: 'gitlab',
    label: 'GitLab',
    blurb:
      'Connect a project or self-hosted instance with a read-api personal access token for the same code checks GitHub gets.',
    connectCta: 'Connect GitLab',
    connectable: false,
  },
  {
    provider: 'cloudflare',
    label: 'Cloudflare',
    blurb:
      'Review DNS and zone posture with a scoped read-only API token — the ownership claims behind your sites, checked.',
    connectCta: 'Connect Cloudflare',
    connectable: false,
  },
]

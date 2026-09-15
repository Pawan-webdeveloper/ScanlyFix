/**
 * A public status page.
 *
 * Readable without an account, because that is the point: it is the link a
 * team posts during an incident, to customers who have no login and are not
 * going to make one. Keyed by slug rather than id — the schema generates one
 * so a shareable URL never carries a UUID.
 *
 * It is also the cheapest acquisition surface in the product. This page sits
 * on somebody else's incident, under our name, in front of their users.
 *
 * Multi-component (Phase 6.1): renders one <ComponentCard> per enabled
 * monitor, with an aggregated header on top. No "single monitor"
 * assumption anywhere in this file.
 *
 * Subscribe (Phase 6.3): the page also carries a subscribe-to-updates
 * form. The query params `confirmed=1` / `unsubscribed=1` show a
 * one-line banner so the user knows their click landed.
 *
 * Polish (Phase 6.4):
 *   - Project logo + brand colour applied when the owner has set them.
 *   - "Last updated X ago" indicator + manual Refresh button.
 *   - Project-level maintenance banner aggregated across all components.
 *   - robots meta: indexable by default; owner can opt out.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getPublicStatus } from '@scanlyfix/db'
import { StatusHeader, formatLastUpdated } from '@/components/status/status-header'
import { ComponentCard } from '@/components/status/component-card'
import { StatusSubscribeForm } from '@/components/status/status-subscribe-form'
import { LastUpdatedIndicator } from '@/components/status/last-updated-indicator'
import { ProjectMaintenanceBanner } from '@/components/status/project-maintenance-banner'

/**
 * Cached for a minute. It is public, it is linked during exactly the moments
 * traffic spikes, and the underlying data changes once a minute at most — so
 * rendering it per request would be paying for nothing at the worst time.
 */
export const revalidate = 60

const SLUG_REGEX = /^[a-z0-9-]+$/

function isValidSlug(slug: string): boolean {
  return SLUG_REGEX.test(slug)
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  if (!isValidSlug(slug)) return { title: 'Status page not found' }

  const data = await getPublicStatus(slug)
  if (!data) return { title: 'Status page not found' }

   return {
     title: `${data.projectName} status`,
     description: `Live status and uptime for ${data.projectUrl}.`,
   }
}

export default async function StatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { slug } = await params
  const sp = await searchParams

  if (!isValidSlug(slug)) notFound()

  const data = await getPublicStatus(slug)
  if (!data) notFound()

  const justConfirmed = sp['confirmed'] === '1'
  const justUnsubscribed = sp['unsubscribed'] === '1'

  // Phase 6.4: project-wide maintenance banner. Today every component
  // surfaces its own window; we aggregate to a single list so the
  // visitor sees one "we're doing maintenance" message, not three.
  // The set of active windows is tiny in practice (1–2), so we render
  // them all in one banner rather than picking "the worst".
  const activeMaintenanceWindows = data.components
    .map((c) => c.maintenance)
    .filter((m): m is NonNullable<typeof m> => m !== null)

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <StatusHeader
        projectName={data.projectName}
        projectUrl={data.projectUrl}
        overallStatus={data.overallStatus}
        lastCheckedAt={data.lastCheckedAt}
        uptimePercent={data.uptimePercent}
        componentCount={data.components.length}
        branding={data.branding}
      />

      {justConfirmed && (
        <div
          role="status"
          data-testid="status-subscribe-confirmed-banner"
          className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
        >
          You're subscribed — you'll receive an email the next time this
          status page reports an incident.
        </div>
      )}

      {justUnsubscribed && (
        <div
          role="status"
          data-testid="status-unsubscribed-banner"
          className="mt-6 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600"
        >
          You've been unsubscribed from status updates for{' '}
          <strong>{data.projectName}</strong>.
        </div>
      )}

      {activeMaintenanceWindows.length > 0 && (
        <ProjectMaintenanceBanner windows={activeMaintenanceWindows} />
      )}

      <div className="mt-8 space-y-4">
        {data.components.map((component) => (
          <ComponentCard key={component.id} {...component} />
        ))}
      </div>

      {/* Phase 6.4: last-updated + manual refresh, shared at the page
          level so the indicator stays in one place across all
          component cards. */}
      {data.lastCheckedAt && (
        <LastUpdatedIndicator
          label={formatLastUpdated(data.lastCheckedAt)}
          iso={data.lastCheckedAt.toISOString()}
        />
      )}

      {/* Subscribe — the only thing the page asks the visitor for. */}
      <section
        aria-labelledby="subscribe-heading"
        data-testid="status-subscribe-section"
        className="mt-12 rounded-lg border border-gray-100 bg-white p-5"
      >
        <h2
          id="subscribe-heading"
          className="mb-1 text-sm font-medium text-gray-700"
        >
          Subscribe to updates
        </h2>
        <p className="mb-4 text-xs text-gray-500">
          Get an email when an incident is opened, updated, or resolved.
          No marketing — only status changes.
        </p>
        <StatusSubscribeForm slug={slug} />
      </section>

      <p className="mt-8 text-sm text-muted">
        Checked by{' '}
        <Link href="/" className="link">
          ScanlyFix
        </Link>
        .
      </p>
    </div>
  )
}

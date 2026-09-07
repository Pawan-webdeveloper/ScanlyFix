import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getViewer } from '@/lib/authz.ts'
import { listMonitorsForUser, listProjectSummaries } from '@scanlyfix/db'
import { MonitoringDetail } from '@/components/monitors/monitoring-detail.tsx'
import { PageHeader } from '@/components/console/page-header.tsx'
import { PageMotion } from '@/components/console/motion.tsx'
import { Icon } from '@/components/console/icons.tsx'

export const metadata = { title: 'SSL & Domain Monitoring — ScanlyFix' }

/**
 * SSL & domain monitoring page.
 *
 * Layout follows the dashboard's reading order:
 *   1. Stats strip  — three counts (total, expiring soon, critical)
 *   2. Monitor cards — one Card per domain monitor, with MonitoringDetail inside
 *
 * Motion contract: server renders final state; PageMotion island reveals
 * and counts as each section is scrolled to. Same as the dashboard.
 */
export default async function MonitoringPage() {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') notFound()

  const [allMonitors, projects] = await Promise.all([
    listMonitorsForUser(viewer),
    listProjectSummaries(viewer),
  ])

  const domainMonitors = allMonitors.filter((m) => m.type === 'domain')
  // Same rule as /monitors: paused monitors must never inflate the
  // "needs attention" / "critical" tiles, because their frozen lastStatus
  // is typically "down" (the very reason they were paused).
  const enabledDomainMonitors = domainMonitors.filter((m) => m.enabled)

  // Stats computed server-side — same data, no extra query
  const expiringSoon = enabledDomainMonitors.filter(
    (m) => m.lastStatus !== 'up' || m.isStale,
  ).length
  // We don't have daysUntilExpiry on the list row, so "down" proxies for "critical"
  const critical = enabledDomainMonitors.filter((m) => m.lastStatus === 'down').length

  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Monitoring" />

      <div
        data-motion-scope="monitoring"
        className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10"
      >
        <PageMotion scope="monitoring" />

        {/* ---------------------------------------------------------------- */}
        {/* Stats strip                                                       */}
        {/* ---------------------------------------------------------------- */}
        <section data-reveal="" aria-label="Monitoring summary">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <BigStat
              icon="shield"
              label="SSL & domain monitors"
              value={String(domainMonitors.length)}
              hint="across all projects"
            />
            <BigStat
              icon="bell"
              label="Needs attention"
              value={String(expiringSoon)}
              hint="not passing last check"
              tone={expiringSoon > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
            />
            <BigStat
              icon="threat"
              label="Critical"
              value={String(critical)}
              hint="last check failed"
              tone={critical > 0 ? 'text-sev-critical' : undefined}
            />
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Monitor cards / empty state                                       */}
        {/* ---------------------------------------------------------------- */}
        {domainMonitors.length === 0 ? (
          <EmptyState projects={projects} />
        ) : (
          <section className="flex flex-col gap-6">
            {domainMonitors.map((m) => (
              <Card
                key={m.id}
                data-reveal=""
                title={m.projectName}
                subtitle={m.projectUrl}
                action={
                  <CardAction href={`/monitors/${m.id}`}>View details</CardAction>
                }
              >
                <div data-reveal-item="" className="px-6 py-5">
                  <MonitoringDetail monitorId={m.id} />
                </div>
              </Card>
            ))}
          </section>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Configure CTA when monitors exist but more projects can be added  */}
        {/* ---------------------------------------------------------------- */}
        {domainMonitors.length > 0 && projects.length > 0 && (
          <div data-reveal="" className="flex justify-end">
            <Link
              data-reveal-item=""
              href={`/projects/${projects[0]?.project.id}/monitors`}
              data-press=""
              className="inline-flex items-center gap-1.5 rounded-lg border border-c-line bg-c-card px-3.5 py-2 text-[13px] font-medium text-c-ink transition-colors hover:bg-c-soft"
            >
              <Icon name="plus" size={14} />
              Configure monitors
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Card — monitors/page variant with subtitle support                          */
/* -------------------------------------------------------------------------- */

/**
 * Same design as the dashboard Card, extended with an optional subtitle line
 * (the project URL) beneath the title. The subtitle appears in the header row,
 * so the card chrome stays uniform whether or not it is present.
 */
function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
  ...rest
}: {
  title?: string
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
} & Omit<React.ComponentProps<'section'>, 'title' | 'action' | 'className' | 'children'>) {
  return (
    <section
      {...rest}
      className={`overflow-hidden rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {(title || action) && (
        <header
          data-reveal-item=""
          className="flex items-center justify-between gap-4 border-b border-c-line px-6 py-4"
        >
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium text-c-ink">{title}</h2>}
            {subtitle && (
              <p className="mt-0.5 truncate font-mono text-[12px] text-c-muted">{subtitle}</p>
            )}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

function CardAction({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      data-press=""
      className="shrink-0 rounded-md border border-c-line bg-c-card px-3 py-1.5 text-[12px] font-medium text-c-ink
                 transition-colors hover:bg-c-soft"
    >
      {children}
    </Link>
  )
}

/* -------------------------------------------------------------------------- */
/* BigStat                                                                     */
/* -------------------------------------------------------------------------- */

function BigStat({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentProps<typeof Icon>['name']
  label: string
  value: string
  hint: string
  tone?: string
}) {
  return (
    <div
      data-reveal-item=""
      className="rounded-lg border border-c-line bg-c-card p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
    >
      <p className="flex items-center gap-2 text-[12px] font-medium text-c-muted">
        <Icon name={icon} size={14} />
        {label}
      </p>
      <p
        data-count={value}
        className={`console-num mt-3 text-2xl font-semibold leading-none tracking-tight ${tone ?? 'text-c-ink'}`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[12px] text-c-muted">{hint}</p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                 */
/* -------------------------------------------------------------------------- */

type ProjectSummaryItem = Awaited<ReturnType<typeof listProjectSummaries>>[number]

function EmptyState({ projects }: { projects: ProjectSummaryItem[] }) {
  return (
    <section
      data-reveal=""
      className="overflow-hidden rounded-lg border border-c-line bg-c-card shadow-[0_1px_2px_rgba(0,0,0,0.04)]"
    >
      <div data-reveal-item="" className="px-6 py-10 text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-lg border border-c-line bg-c-soft text-c-muted">
          <Icon name="shield" size={20} />
        </span>
        <p className="mt-4 text-sm font-medium text-c-ink">No SSL &amp; domain monitors active</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-c-muted text-pretty">
          Track TLS certificate expiration (14d/7d alerts) and domain registration expiry
          (30d/7d alerts) automatically.
        </p>

        {projects.length > 0 ? (
          <div className="mx-auto mt-6 max-w-md">
            <p className="label mb-3 text-c-muted">Your domains ({projects.length})</p>
            <ul className="overflow-hidden rounded-lg border border-c-line bg-c-card">
              {projects.map((p) => (
                <li
                  key={p.project.id}
                  className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-c-line"
                >
                  <Link
                    href={`/projects/${p.project.id}/monitors`}
                    data-press=""
                    className="flex items-center justify-between px-5 py-3.5 transition-colors hover:bg-c-soft/60"
                  >
                    <div className="min-w-0 text-left">
                      <p className="truncate text-sm font-medium text-c-ink">{p.project.name}</p>
                      <p className="truncate font-mono text-[12px] text-c-muted">{p.project.url}</p>
                    </div>
                    <span className="shrink-0 text-[12px] font-medium text-c-accent">
                      Enable certificate check →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Link
            href="/dashboard"
            data-press=""
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-c-line bg-c-card px-3.5 py-2 text-[13px] font-medium text-c-ink transition-colors hover:bg-c-soft"
          >
            <Icon name="plus" size={14} />
            Add a domain on Dashboard
          </Link>
        )}
      </div>
    </section>
  )
}

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getViewer } from '@/lib/authz.ts'
import { listMonitorsForUser, listProjectSummaries } from '@scanlyfix/db'
import { MonitorList } from '@/components/monitors/monitor-list'
import { PageHeader } from '@/components/console/page-header.tsx'
import { PageMotion } from '@/components/console/motion.tsx'
import { Icon } from '@/components/console/icons.tsx'

export const metadata = { title: 'Uptime & Monitors — ScanlyFix' }

/**
 * The uptime page.
 *
 * Layout follows the dashboard's reading order exactly:
 *   1. Stats strip  — four counts that answer "how am I doing"
 *   2. Monitor list — the detail that answers "which ones specifically"
 *
 * Motion contract: same as the dashboard — server renders final state,
 * PageMotion island reveals, staggers and counts as each section is reached.
 * Stats strip uses data-reveal so the numbers count up on arrival.
 */
export default async function MonitorsPage() {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') notFound()

  const [monitors, projects] = await Promise.all([
    listMonitorsForUser(viewer),
    listProjectSummaries(viewer),
  ])

  // Counts for the stats strip — computed server-side from the list we already have.
  // Disabled monitors are excluded from every health tile: a paused monitor's
  // lastStatus is whatever it was the moment it was paused (frequently
  // "down" — pausing is what you do when a site is down), so counting it
  // would inflate the "Down" tile every time the user opened the page.
  const uptimeMonitors = monitors.filter((m) => m.type === 'uptime')
  const enabledUptime = uptimeMonitors.filter((m) => m.enabled)
  const upCount = enabledUptime.filter((m) => m.lastStatus === 'up').length
  const downCount = enabledUptime.filter((m) => m.lastStatus === 'down').length
  const staleCount = enabledUptime.filter(
    (m) => m.isStale || m.lastStatus === 'stale',
  ).length

  const hasMonitors = monitors.length > 0

  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Uptime" />

      <div
        data-motion-scope="monitors"
        className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10"
      >
        <PageMotion scope="monitors" />

        {/* ---------------------------------------------------------------- */}
        {/* Stats strip                                                       */}
        {/* ---------------------------------------------------------------- */}
        <section data-reveal="" aria-label="Uptime summary">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <BigStat
              icon="uptime"
              label="Total monitors"
              value={String(monitors.length)}
              hint="across all projects"
            />
            <BigStat
              icon="shield"
              label="Operational"
              value={String(upCount)}
              hint="last check passed"
              tone={upCount > 0 ? 'text-emerald-600 dark:text-emerald-400' : undefined}
            />
            <BigStat
              icon="bell"
              label="Down"
              value={String(downCount)}
              hint="last check failed"
              tone={downCount > 0 ? 'text-sev-critical' : undefined}
            />
            <BigStat
              icon="globe"
              label="Stale"
              value={String(staleCount)}
              hint="overdue for a check"
              tone={staleCount > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
            />
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Monitor list / empty state                                        */}
        {/* ---------------------------------------------------------------- */}
        <Card
          title="Monitors"
          data-reveal=""
          action={
            projects.length > 0 ? (
              <CardAction href={`/projects/${projects[0]?.project.id}/monitors`}>
                Configure monitors
              </CardAction>
            ) : null
          }
        >
          {!hasMonitors ? (
            <EmptyState projects={projects} />
          ) : (
            <MonitorList />
          )}
        </Card>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared card primitives (mirrors dashboard exactly)                          */
/* -------------------------------------------------------------------------- */

function Card({
  title,
  action,
  children,
  className = '',
  ...rest
}: {
  title?: string
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
          {title && <h2 className="text-sm font-medium text-c-ink">{title}</h2>}
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
      className="rounded-md border border-c-line bg-c-card px-3 py-1.5 text-[12px] font-medium text-c-ink
                 transition-colors hover:bg-c-soft"
    >
      {children}
    </Link>
  )
}

/* -------------------------------------------------------------------------- */
/* BigStat — mirrors the dashboard's asset summary strip                       */
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
    <div data-reveal-item="" className="px-6 py-10 text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-lg border border-c-line bg-c-soft text-c-muted">
        <Icon name="uptime" size={20} />
      </span>
      <p className="mt-4 text-sm font-medium text-c-ink">No monitors active yet</p>
      <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-c-muted text-pretty">
        Turn on uptime checks for your projects to get real-time health pings and downtime alerts.
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
                    Enable uptime →
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
  )
}

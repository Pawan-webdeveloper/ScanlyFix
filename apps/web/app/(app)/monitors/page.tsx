import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getViewer } from '@/lib/authz.ts'
import { listMonitorsForUser, listProjectSummaries } from '@scanlyfix/db'
import { MonitorList } from '@/components/monitors/monitor-list'
import { PageHeader } from '@/components/console/page-header.tsx'
import { PageMotion } from '@/components/console/motion.tsx'

export const metadata = { title: 'Uptime & Monitors — ScanlyFix' }

/**
 * The uptime page, on the console's shared chrome: same header, same container
 * rhythm, and the same motion contract as the dashboard — the server renders
 * every state final, and the PageMotion island reveals, staggers and counts
 * as each section is reached.
 */
export default async function MonitorsPage() {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') notFound()

  const [monitors, projects] = await Promise.all([
    listMonitorsForUser(viewer),
    listProjectSummaries(viewer),
  ])

  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Uptime" />

      <div
        data-motion-scope="monitors"
        className="mx-auto flex w-full max-w-[1200px] flex-col px-6 py-8 sm:px-10"
      >
        <PageMotion scope="monitors" />

        <div
          data-reveal=""
          className="mb-6 flex flex-wrap items-center justify-between gap-4"
        >
          <div data-reveal-item="">
            <h2 className="text-xl font-semibold tracking-tight text-c-ink">Uptime Monitors</h2>
            <p className="mt-1 text-sm text-c-muted">
              Live uptime and response time checks running across your projects.
            </p>
          </div>
          {projects.length > 0 && (
            <Link
              href={`/projects/${projects[0]?.project.id}/monitors`}
              data-reveal-item=""
              data-press=""
              className="inline-flex items-center gap-1.5 rounded-lg bg-c-brand px-3.5 py-2 text-xs font-semibold text-c-brand-ink transition-opacity hover:opacity-90"
            >
              + Configure Monitors
            </Link>
          )}
        </div>

        {monitors.length === 0 ? (
          <div data-reveal="" className="rounded-xl border border-dashed border-c-line bg-c-card p-10 text-center shadow-xs">
            <div data-reveal-item="" className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-c-soft text-xl">
              ⚡
            </div>
            <h3 data-reveal-item="" className="mt-3 text-sm font-semibold text-c-ink">No monitors active yet</h3>
            <p data-reveal-item="" className="mx-auto mt-1 max-w-sm text-xs text-c-muted">
              Turn on Uptime checks for your projects to get real-time health pings and downtime alerts.
            </p>

            {projects.length > 0 ? (
              <div data-reveal-item="" className="mt-6 border-t border-c-line/60 pt-6">
                <p className="text-xs font-medium uppercase tracking-wider text-c-muted">
                  Your Domains ({projects.length})
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  {projects.map((p) => (
                    <Link
                      key={p.project.id}
                      href={`/projects/${p.project.id}/monitors`}
                      data-press=""
                      className="flex items-center justify-between rounded-lg border border-c-line bg-c-soft/50 px-4 py-3 transition-colors hover:border-c-brand/50 hover:bg-c-soft"
                    >
                      <div className="text-left">
                        <p className="text-sm font-medium text-c-ink">{p.project.name}</p>
                        <p className="font-mono text-xs text-c-muted">{p.project.url}</p>
                      </div>
                      <span className="text-xs font-semibold text-c-brand">
                        Enable Uptime →
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <div data-reveal-item="" className="mt-5">
                <Link
                  href="/dashboard"
                  data-press=""
                  className="inline-flex items-center rounded-lg bg-c-brand px-4 py-2 text-xs font-semibold text-c-brand-ink"
                >
                  Add a Domain on Dashboard
                </Link>
              </div>
            )}
          </div>
        ) : (
          <MonitorList />
        )}
      </div>
    </div>
  )
}

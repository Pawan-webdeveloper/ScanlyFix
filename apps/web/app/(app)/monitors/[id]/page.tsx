import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { getViewer } from '@/lib/authz.ts'
import {
  db,
  listMonitorsForUser,
  getOpenIncident,
  monitors as monitorsTable,
  projects,
} from '@scanlyfix/db'
import { parseAlertConfig, type AlertConfig } from '@/lib/alert-threshold.ts'
import { MonitoringDetail } from '@/components/monitors/monitoring-detail.tsx'
import { UptimeHeader } from '@/components/console/uptime-header.tsx'
import { UptimeView } from '@/components/monitors/uptime-view.tsx'
import { Icon } from '@/components/console/icons.tsx'

interface Props {
  params: Promise<{ id: string }>
}

const FAILURES_BEFORE_ALERT_DEFAULT = 1

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  const viewer = await getViewer()
  if (viewer.kind !== 'user') return {}
  const monitors = await listMonitorsForUser(viewer)
  const monitor = monitors.find((m) => m.id === id)
  if (!monitor) return {}
  return { title: `${monitor.projectName} — Uptime` }
}

/**
 * The monitor detail page, rewritten to the checkvibe layout.
 *
 * Reading order is fixed by design:
 *   1. Header           — workspace breadcrumb + back chevron
 *   2. Project block    — URL + name + Refresh + Monitoring toggle
 *   3. Status hero      — pulsing dot + Down/Up + timestamps
 *   4. Availability     — 90-day strip + legend + period tabs
 *   5. Stats row        — 24h / 7d / 30d / answer speed
 *   6. Downtime history — Live pill + ongoing outage card
 *   7. Monitor settings — Checks / Email me after / Alerts go to
 *
 * Server-side we resolve the project slug (for the public status link), the
 * open incident (for the "Down since" timestamp), and the alert config
 * (for the segmented-button initial state). The client component polls the
 * uptime endpoint and incident list on its own.
 */
export default async function MonitorDetailPage({ params }: Props) {
  const { id } = await params

  const viewer = await getViewer()
  if (viewer.kind !== 'user') notFound()

  const monitors = await listMonitorsForUser(viewer)
  const monitor = monitors.find((m) => m.id === id)
  if (!monitor) notFound()

  if (monitor.type === 'domain') {
    // SSL & Domain detail uses the existing component — unchanged.
    return <DomainMonitorPage monitorId={monitor.id} projectName={monitor.projectName} projectUrl={monitor.projectUrl} />
  }

  // Resolve slug + open incident + alert config in parallel.
  const [projectRow, openIncident, monitorAlertRow] = await Promise.all([
    db.query.projects.findFirst({
      where: eq(projects.id, monitor.projectId),
      columns: { slug: true },
    }),
    getOpenIncident(monitor.id),
    db.query.monitors.findFirst({
      where: eq(monitorsTable.id, monitor.id),
      columns: { alertConfig: true },
    }),
  ])

  const parsedConfig = parseAlertConfig(monitorAlertRow?.alertConfig ?? {})
  const config: AlertConfig = parsedConfig.ok ? parsedConfig.config : ({} as AlertConfig)

  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <UptimeHeader
        breadcrumb={[
          { label: monitor.projectName, href: `/projects/${monitor.projectId}` },
          { label: 'Uptime' },
        ]}
      />

      <div className="mx-auto w-full max-w-[1100px] px-6 py-8 sm:px-10">
        <Link
          href="/monitors"
          className="mb-4 inline-flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-900"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m15 6-6 6 6 6" />
          </svg>
          All domains
        </Link>

        <UptimeView
          monitorId={monitor.id}
          projectName={monitor.projectName}
          projectUrl={monitor.projectUrl}
          slug={projectRow?.slug ?? null}
          initialStatus={
            monitor.lastStatus === 'up' || monitor.lastStatus === 'down'
              ? monitor.lastStatus
              : null
          }
          initialLastRunAt={monitor.lastRunAt?.toISOString() ?? null}
          initialDownSince={
            openIncident && monitor.lastStatus === 'down'
              ? openIncident.startedAt.toISOString()
              : null
          }
          initialLastDetail={monitor.lastDetail ?? null}
          initialFailuresBeforeAlert={coerceFailures(
            config.failuresBeforeAlert,
          )}
          initialAlertEmail={config.alertEmail ?? null}
          intervalS={monitor.intervalS}
        />
      </div>
    </div>
  )
}

function coerceFailures(value: number | undefined): 1 | 2 | 3 | 5 {
  if (value === 1 || value === 2 || value === 3 || value === 5) return value
  return FAILURES_BEFORE_ALERT_DEFAULT as 1 | 2 | 3 | 5
}

function DomainMonitorPage({
  monitorId,
  projectName,
  projectUrl,
}: {
  monitorId: string
  projectName: string
  projectUrl: string
}) {
  return (
    <div className="min-h-dvh bg-white text-gray-900">
      <UptimeHeader breadcrumb={[{ label: projectName }, { label: 'Monitoring' }]} />

      <div className="mx-auto w-full max-w-[900px] px-6 py-8 sm:px-10">
        <Link
          href="/monitoring"
          className="mb-4 inline-flex items-center gap-1 text-xs text-gray-500 transition-colors hover:text-gray-900"
        >
          <Icon name="feed" size={13} />
          Back to Monitoring
        </Link>

        <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <header className="flex items-center justify-between gap-4 border-b border-gray-100 px-6 py-4">
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-gray-900">{projectName}</h2>
              <p className="mt-0.5 truncate font-mono text-xs text-gray-500">
                {projectUrl}
              </p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-700">
              <Icon name="shield" size={11} />
              SSL &amp; Domain
            </span>
          </header>
          <div className="px-6 py-5">
            <MonitoringDetail monitorId={monitorId} />
          </div>
        </section>
      </div>
    </div>
  )
}

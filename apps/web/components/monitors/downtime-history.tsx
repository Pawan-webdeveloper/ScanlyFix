'use client'

/**
 * Downtime history list.
 *
 * checkvibe shape:
 *   - section header on the left ("Downtime history"), count on the right
 *   - one entry per incident: Live pill, title, description, timestamp
 *
 * The Live pill renders only for ongoing incidents; resolved incidents use
 * the neutral "Resolved" pill instead. The title comes from the incident
 * `detail`, falling back to a generic string when the probe never recorded
 * one.
 */

interface IncidentEntry {
  id: string
  status: 'ongoing' | 'resolved'
  startedAt: string
  resolvedAt: string | null
  detail: string | null
  statusCode: number | null
}

interface DowntimeHistoryProps {
  incidents: ReadonlyArray<IncidentEntry>
}

const FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return FORMATTER.format(d).replace(' UTC', ' UTC')
}

export function DowntimeHistory({ incidents }: DowntimeHistoryProps) {
  return (
    <section
      className="rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
      aria-label="Downtime history"
    >
      <header className="flex items-center justify-between gap-4 border-b border-gray-100 px-5 py-4">
        <h2 className="text-[15px] font-semibold text-gray-900">Downtime history</h2>
        <span className="text-xs text-gray-500">
          {incidents.length} recorded
        </span>
      </header>

      {incidents.length === 0 ? (
        <p className="px-5 py-6 text-sm text-gray-500">
          No downtime recorded — all good.
        </p>
      ) : (
        <ul>
          {incidents.map((incident) => (
            <IncidentRow key={incident.id} incident={incident} />
          ))}
        </ul>
      )}
    </section>
  )
}

function IncidentRow({ incident }: { incident: IncidentEntry }) {
  const isOngoing = incident.status === 'ongoing'
  const title = isOngoing ? 'Ongoing outage' : 'Past outage'
  const description =
    incident.detail ??
    (incident.statusCode
      ? `HTTP probe returned status ${incident.statusCode}.`
      : 'A check failed; see logs for the full probe response.')

  return (
    <li className="flex items-start justify-between gap-4 px-5 py-4 first:pt-5 last:pb-5 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-gray-100">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isOngoing ? <LivePill /> : <ResolvedPill />}
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        </div>
        <p className="mt-1 text-sm text-gray-600">{description}</p>
      </div>
      <time
        dateTime={incident.startedAt}
        className="shrink-0 text-xs tabular-nums text-gray-500"
      >
        {fmt(incident.startedAt)}
      </time>
    </li>
  )
}

function LivePill() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-700">
      <span className="relative grid h-2 w-2 place-items-center" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      </span>
      Live
    </span>
  )
}

function ResolvedPill() {
  return (
    <span className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-600">
      Resolved
    </span>
  )
}

'use client'

import { useState, useTransition } from 'react'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface Incident {
  id: string
  startedAt: string
  resolvedAt: string | null
  durationMs: number | null
  statusCode: number | null
  detail: string | null
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  acknowledgerEmail: string | null
  notes: string | null
}

interface IncidentsListProps {
  incidents: Incident[]
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function shortName(email: string | null): string {
  if (!email) return 'Unknown user'
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/* -------------------------------------------------------------------------- */
/* IncidentsList                                                               */
/* -------------------------------------------------------------------------- */

export function IncidentsList({ incidents }: IncidentsListProps) {
  if (incidents.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-c-muted text-pretty">
        No incidents recorded — all good.
      </p>
    )
  }

  return (
    <ul>
      {incidents.map((incident) => (
        <IncidentRow key={incident.id} incident={incident} />
      ))}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */
/* IncidentRow                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Owns its own state so ack/notes interactions do not re-render the whole list.
 * The list is bounded (default 50 rows), but the textarea would be the slow
 * part without this split.
 */
function IncidentRow({ incident: initial }: { incident: Incident }) {
  const [incident, setIncident] = useState<Incident>(initial)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<string>(initial.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const isOpen = incident.resolvedAt === null
  const isAcked = incident.acknowledgedAt !== null
  // Only open incidents can be re-acked — a resolved incident already has its
  // full audit trail; a re-ack would lie about who handled it.
  const canAck = isOpen

  function ack() {
    setError(null)
    startTransition(async () => {
      const res = await fetch(`/api/incidents/${incident.id}/ack`, { method: 'POST' })
      const data = (await res.json()) as { incident?: Incident; error?: string }
      if (!res.ok) { setError(data.error ?? 'Failed to acknowledge'); return }
      if (data.incident) setIncident(data.incident)
    })
  }

  function saveNotes() {
    setError(null)
    startTransition(async () => {
      const res = await fetch(`/api/incidents/${incident.id}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: draft.length > 0 ? draft : null }),
      })
      const data = (await res.json()) as { incident?: Incident; error?: string }
      if (!res.ok) { setError(data.error ?? 'Failed to save notes'); return }
      if (data.incident) { setIncident(data.incident); setDraft(data.incident.notes ?? '') }
    })
  }

  return (
    <li className="[&:not(:first-child)]:border-t [&:not(:first-child)]:border-c-line">
      <div className="py-4">
        {/* ── Main row ──────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4">
          {/* Left: status badges + date + detail */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {/* Ongoing / Resolved badge */}
              <span
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                  isOpen
                    ? 'border-sev-critical/30 bg-sev-critical/10 text-sev-critical'
                    : 'border-c-line bg-c-soft text-c-muted'
                }`}
              >
                {isOpen && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sev-critical" />
                )}
                {isOpen ? 'Ongoing' : 'Resolved'}
              </span>

              {/* HTTP status code */}
              {incident.statusCode && (
                <span className="console-num font-mono text-[12px] text-c-muted">
                  HTTP {incident.statusCode}
                </span>
              )}

              {/* Acknowledged badge */}
              {isAcked && (
                <span
                  data-testid="acknowledged-badge"
                  title={`Acknowledged at ${formatDate(incident.acknowledgedAt)}`}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
                >
                  ✓ Acknowledged by {shortName(incident.acknowledgerEmail)}{' '}
                  <span className="font-normal opacity-60">
                    · {formatDate(incident.acknowledgedAt)}
                  </span>
                </span>
              )}
            </div>

            {/* Date range */}
            <p className="console-num mt-1.5 text-[12px] text-c-muted">
              {formatDate(incident.startedAt)}
              {incident.resolvedAt && ` — ${formatDate(incident.resolvedAt)}`}
            </p>

            {/* Detail */}
            {incident.detail && (
              <p className="mt-1 truncate text-[11px] text-c-muted/70">{incident.detail}</p>
            )}
          </div>

          {/* Right: duration + action buttons */}
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className="console-num text-[12px] font-medium text-c-muted">
              {isOpen ? (
                <span className="text-sev-critical">ongoing</span>
              ) : incident.durationMs != null ? (
                formatDuration(incident.durationMs)
              ) : null}
            </span>

            <div className="flex gap-1.5">
              <a
                href={`/incidents/${incident.id}`}
                className="rounded-md border border-c-line bg-c-card px-2.5 py-1 text-[11px] font-medium text-c-muted
                           transition-colors hover:bg-c-soft hover:text-c-ink"
              >
                Timeline
              </a>
              {canAck && !isAcked && (
                <button
                  type="button"
                  onClick={ack}
                  disabled={isPending}
                  className="rounded-md border border-c-line bg-c-card px-2.5 py-1 text-[11px] font-medium text-c-muted
                             transition-colors hover:bg-c-soft hover:text-c-ink disabled:opacity-50"
                >
                  {isPending ? 'Acking…' : 'Acknowledge'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="rounded-md border border-c-line bg-c-card px-2.5 py-1 text-[11px] font-medium text-c-muted
                           transition-colors hover:bg-c-soft hover:text-c-ink"
              >
                {expanded ? 'Hide notes' : incident.notes ? 'Edit notes' : 'Add notes'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Notes panel ─────────────────────────────────────────────── */}
        {expanded && (
          <div className="mt-3 rounded-lg border border-c-line bg-c-soft/40 p-4">
            <label
              htmlFor={`notes-${incident.id}`}
              className="mb-2 block text-[11px] font-medium text-c-muted"
            >
              On-call notes
            </label>
            <textarea
              id={`notes-${incident.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="What did you check? What is the suspected cause?"
              className="w-full rounded-md border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                         placeholder:text-c-muted focus:border-c-accent focus:outline-none"
            />
            {error && (
              <p role="alert" className="mt-1 text-[11px] text-sev-critical">
                {error}
              </p>
            )}
            <div className="mt-2 flex items-center justify-between">
              <p className="text-[11px] text-c-muted">{draft.length}/4000</p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => { setDraft(incident.notes ?? ''); setError(null) }}
                  disabled={isPending}
                  className="rounded-md border border-c-line px-2.5 py-1 text-[11px] text-c-muted
                             transition-colors hover:text-c-ink disabled:opacity-50"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={saveNotes}
                  disabled={isPending || draft === (incident.notes ?? '')}
                  className="rounded-md bg-c-brand px-2.5 py-1 text-[11px] font-semibold text-c-brand-ink
                             transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {isPending ? 'Saving…' : 'Save notes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

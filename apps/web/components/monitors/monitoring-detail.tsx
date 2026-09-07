'use client'

/**
 * SSL certificate + domain expiry status for a project.
 * Used on the /monitoring page and /monitors/[id] page when type is 'domain'.
 *
 * Redesigned to the dashboard's Card vocabulary: rounded-lg borders,
 * c-* token colours, and console-num for numeric readouts.
 */

import { useEffect, useState } from 'react'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

interface SslData {
  ok: boolean
  daysUntilExpiry: number | null
  expiresAt: string | null
  subject: string | null
  detail: string | null
}

interface DomainData {
  ok: boolean
  daysUntilExpiry: number | null
  expiresAt: string | null
  registrar: string | null
  detail: string | null
}

interface MonitoringData {
  hostname: string
  ssl: SslData
  domain: DomainData
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Returns the text colour for the days-remaining counter.
 * Mirrors the urgency ladder in urgencyBg — explicit dark variants so the
 * badge reads on the dark canvas.
 */
function urgencyTextClass(days: number | null): string {
  if (days === null) return 'text-c-muted'
  if (days <= 0) return 'text-sev-critical'
  if (days <= 7) return 'text-sev-critical'
  if (days <= 14) return 'text-sev-high'
  if (days <= 30) return 'text-amber-600 dark:text-amber-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

/**
 * Returns the section-level background + border class.
 * Quiet for healthy; coloured for degraded — mirrors the severity tokens
 * already used throughout the dashboard.
 */
function urgencyContainerClass(days: number | null): string {
  if (days === null) return 'border-c-line bg-c-soft/30'
  if (days <= 7) return 'border-sev-critical/30 bg-sev-critical/5'
  if (days <= 14) return 'border-sev-high/30 bg-sev-high/5'
  if (days <= 30) return 'border-amber-400/30 bg-amber-400/5'
  return 'border-c-line bg-c-soft/30'
}

/* -------------------------------------------------------------------------- */
/* ExpiryCard                                                                  */
/* -------------------------------------------------------------------------- */

interface ExpiryCardProps {
  title: string
  days: number | null
  expiresAt: string | null
  subtitle?: string | null
  detail?: string | null
}

/**
 * One expiry metric card — the same shape as BigStat on the dashboard:
 * a small label row on top, a large counter in the middle, and a hint below.
 */
function ExpiryCard({ title, days, expiresAt, subtitle, detail }: ExpiryCardProps) {
  const daysLabel =
    days === null ? '—' : days <= 0 ? 'Expired' : `${days}`

  return (
    <div className={`rounded-lg border p-5 ${urgencyContainerClass(days)}`}>
      {/* Header row: label + optional subtitle */}
      <p className="flex items-center gap-2 text-[12px] font-medium text-c-muted">
        {title}
      </p>
      {subtitle && (
        <p className="mt-0.5 truncate font-mono text-[11px] text-c-muted/70">{subtitle}</p>
      )}

      {/* Counter */}
      <p
        className={`console-num mt-3 text-2xl font-semibold leading-none tracking-tight ${urgencyTextClass(days)}`}
      >
        {daysLabel}
      </p>
      <p className="mt-1.5 text-[12px] text-c-muted">
        {days === null
          ? 'no data'
          : days <= 0
            ? 'already expired'
            : 'days remaining'}
      </p>

      {/* Expiry date */}
      {expiresAt && days !== null && (
        <p className="mt-3 border-t border-c-line/50 pt-3 text-[12px] text-c-muted">
          {days <= 0 ? 'Expired' : 'Expires'}{' '}
          <span className="font-medium text-c-ink">{formatDate(expiresAt)}</span>
        </p>
      )}

      {detail && (
        <p className="mt-1.5 text-[11px] text-c-muted">{detail}</p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* MonitoringDetail                                                            */
/* -------------------------------------------------------------------------- */

interface MonitoringDetailProps {
  monitorId: string
}

export function MonitoringDetail({ monitorId }: MonitoringDetailProps) {
  const [data, setData] = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/monitors/${monitorId}/monitoring`)
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load monitoring data')
        return r.json() as Promise<MonitoringData>
      })
      .then(setData)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Unknown error'),
      )
      .finally(() => setLoading(false))
  }, [monitorId])

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="h-32 animate-pulse rounded-lg bg-c-soft" />
        <div className="h-32 animate-pulse rounded-lg bg-c-soft" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <p className="text-sm text-sev-critical">{error ?? 'Could not load monitoring data.'}</p>
    )
  }

  return (
    <div className="space-y-4">
      {/* Hostname */}
      <p className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-c-muted">Live health probe</span>
        <span className="font-mono text-[12px] text-c-muted">{data.hostname}</span>
      </p>

      {/* Expiry cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ExpiryCard
          title="SSL Certificate"
          days={data.ssl.daysUntilExpiry}
          expiresAt={data.ssl.expiresAt}
          subtitle={data.ssl.subject ?? undefined}
          detail={data.ssl.detail ?? undefined}
        />
        <ExpiryCard
          title="Domain Registration"
          days={data.domain.daysUntilExpiry}
          expiresAt={data.domain.expiresAt}
          subtitle={data.domain.registrar ?? undefined}
          detail={data.domain.detail ?? undefined}
        />
      </div>

      {/* Threshold note */}
      <p className="text-[11px] text-c-muted">
        Alert thresholds: 14d SSL · 30d domain · urgent at 7d
      </p>
    </div>
  )
}

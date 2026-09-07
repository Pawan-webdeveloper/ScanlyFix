'use client'

import { useEffect, useState } from 'react'

/**
 * Monitor configuration panel — checkvibe shape.
 *
 * Three rows:
 *   1. Checks        read-only: "Every minute, from our servers"
 *   2. Email me after   segmented buttons: 1 / 2 / 3 / 5 in a row
 *   3. Alerts go to  email input + Save button
 *
 * The Save button is disabled until the email field has a value that looks
 * like an email — the same rule checkvibe ships with. This is also why the
 * "Email me after" row is split from "Alerts go to": changing one does NOT
 * auto-save the other.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const INTERVAL_OPTIONS = [1, 2, 3, 5] as const
type FailuresBeforeAlert = (typeof INTERVAL_OPTIONS)[number]

interface MonitorSettingsSectionProps {
  monitorId: string
  /** Probe interval, displayed read-only in the first row. */
  intervalS: number
  /** Initial values, fetched server-side. */
  initialFailuresBeforeAlert: FailuresBeforeAlert
  initialAlertEmail: string | null
}

export function MonitorSettingsSection({
  monitorId,
  intervalS,
  initialFailuresBeforeAlert,
  initialAlertEmail,
}: MonitorSettingsSectionProps) {
  const [failures, setFailures] = useState<FailuresBeforeAlert>(initialFailuresBeforeAlert)
  const [email, setEmail] = useState<string>(initialAlertEmail ?? '')
  const [savedEmail, setSavedEmail] = useState<string | null>(initialAlertEmail)
  const [savedFailures, setSavedFailures] =
    useState<FailuresBeforeAlert>(initialFailuresBeforeAlert)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const isValidEmail = EMAIL_REGEX.test(email)
  const isDirty =
    failures !== savedFailures || email.trim() !== (savedEmail ?? '').trim()
  const canSave = isValidEmail && isDirty && !isSaving

  // Re-sync from server if the route re-renders with new initial values.
  useEffect(() => {
    setFailures(initialFailuresBeforeAlert)
    setEmail(initialAlertEmail ?? '')
    setSavedEmail(initialAlertEmail)
    setSavedFailures(initialFailuresBeforeAlert)
  }, [monitorId, initialFailuresBeforeAlert, initialAlertEmail])

  async function save() {
    if (!canSave) return
    setIsSaving(true)
    setError(null)
    setSavedAt(null)
    try {
      const res = await fetch(`/api/monitors/${monitorId}/alert-preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          failuresBeforeAlert: failures,
          alertEmail: email.trim(),
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? 'Failed to save alert preferences')
      }
      setSavedEmail(email.trim())
      setSavedFailures(failures)
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
      aria-label="Monitor settings"
    >
      <header className="border-b border-gray-100 px-5 py-4">
        <h2 className="text-[15px] font-semibold text-gray-900">Monitor</h2>
      </header>

      <ul>
        <Row label="Checks">
          <span className="text-sm text-gray-700">{formatInterval(intervalS)}</span>
        </Row>

        <Row label="Email me after">
          <SegmentedGroup
            options={INTERVAL_OPTIONS}
            value={failures}
            onChange={setFailures}
          />
        </Row>

        <Row label="Alerts go to" last>
          <div className="flex items-center gap-2">
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-56 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              aria-invalid={email.length > 0 && !isValidEmail}
            />
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Row>
      </ul>

      <footer className="border-t border-gray-100 px-5 py-3 text-xs text-gray-500">
        {error ? (
          <span className="text-red-600">{error}</span>
        ) : savedAt && Date.now() - savedAt < 4000 ? (
          <span className="text-emerald-600">Saved.</span>
        ) : (
          'Changes save per row. Save is disabled until the email is valid.'
        )}
      </footer>
    </section>
  )
}

function Row({
  label,
  children,
  last = false,
}: {
  label: string
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <li
      className={`flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 ${
        last ? '' : 'border-b border-gray-100'
      }`}
    >
      <span className="text-sm font-medium text-gray-700">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </li>
  )
}

function SegmentedGroup({
  options,
  value,
  onChange,
}: {
  options: readonly FailuresBeforeAlert[]
  value: FailuresBeforeAlert
  onChange: (next: FailuresBeforeAlert) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Email me after N failed checks"
      className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 p-0.5"
    >
      {options.map((option) => {
        const active = option === value
        const label =
          option === 1
            ? '1 failed check'
            : option === 2
              ? '2 in a row'
              : option === 3
                ? '3 in a row'
                : '5 in a row'
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option)}
            className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? 'border border-blue-200 bg-white text-blue-700 shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function formatInterval(s: number): string {
  if (s >= 86_400) return 'Every day'
  if (s >= 3_600) return `Every ${Math.round(s / 60)} minutes`
  if (s >= 60) return `Every ${Math.round(s / 60)} minutes`
  return `Every ${s}s`
}

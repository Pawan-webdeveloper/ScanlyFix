'use client'

/*
 * Alert threshold configuration UI for uptime monitors.
 *
 * Extended with:
 *   - Keyword check (should_contain / should_not_contain)
 *   - Expected status codes (comma-separated)
 *   - HTTP method (GET / HEAD)
 *   - Custom headers (add/remove, values masked)
 *   - Reminder interval
 *
 * WHY no form tag: existing codebase pattern (monitor-detail.tsx same)
 * WHY local state (not React Query): simple save — no cache invalidation needed
 */

import { useState, useEffect, useCallback } from 'react'
import { ALERT_PRESETS, type AlertPresetKey, type AlertConfig } from '@/lib/alert-threshold.ts'

interface MonitorSettingsProps {
  monitorId: string
  onSaved?: () => void
}

interface MaskedHeader {
  key: string
  valueMasked: string
}

// ─── Preset detector ──────────────────────────────────────────────────────────
// WHY: Map saved failStatusCodes back to a preset key for the dropdown
function detectPreset(alertConfig: AlertConfig | null): AlertPresetKey {
  if (!alertConfig?.failStatusCodes || alertConfig.failStatusCodes.length === 0) {
    return 'default'
  }
  const codes = new Set(alertConfig.failStatusCodes)

  if (
    codes.size === ALERT_PRESETS['5xx_only'].failStatusCodes.length &&
    ALERT_PRESETS['5xx_only'].failStatusCodes.every((c) => codes.has(c))
  ) {
    return '5xx_only'
  }
  if (codes.size >= 200 && [...codes].every((c) => c >= 400)) {
    return '4xx_and_5xx'
  }
  return 'default'
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateStatusCodes(input: string): string | null {
  if (!input.trim()) return null // Empty is valid (uses preset)
  const codes = input.split(',').map((s) => s.trim())
  for (const code of codes) {
    const num = parseInt(code, 10)
    if (isNaN(num) || num < 100 || num > 599) {
      return `Invalid status code: ${code}`
    }
  }
  return null
}

function validateKeyword(value: string): string | null {
  if (!value) return null
  if (value.length > 500) {
    return `Keyword too long (${value.length}/500 chars)`
  }
  return null
}

function validateHeaderKey(key: string): string | null {
  if (!key) return 'Header key required'
  if (key.length > 100) return 'Header key too long'
  if (!/^[a-zA-Z0-9-]+$/.test(key)) {
    return 'Only alphanumeric and hyphens allowed'
  }
  return null
}

// ─── Component ─────────────────────────────────────────────────────────────────
export function MonitorSettings({ monitorId, onSaved }: MonitorSettingsProps) {
  // Basic fields
  const [preset, setPreset] = useState<AlertPresetKey>('default')
  const [maxLatencyMs, setMaxLatencyMs] = useState<string>('')

  // Keyword check
  const [keywordType, setKeywordType] = useState<'should_contain' | 'should_not_contain'>('should_contain')
  const [keywordValue, setKeywordValue] = useState<string>('')

  // Expected status codes
  const [expectedStatusCodes, setExpectedStatusCodes] = useState<string>('')

  // HTTP method
  const [httpMethod, setHttpMethod] = useState<'GET' | 'HEAD'>('GET')

  // Custom headers
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([])
  const [existingHeaders, setExistingHeaders] = useState<MaskedHeader[]>([])
  const [newHeaderKey, setNewHeaderKey] = useState('')
  const [newHeaderValue, setNewHeaderValue] = useState('')

  // Reminder interval
  const [reminderIntervalMin, setReminderIntervalMin] = useState<string>('')

  // UI state
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  // ── Load current config ──────────────────────────────────────────────────────
  const loadConfig = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/monitors/${monitorId}/config`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to load config')

      const data = await res.json() as { alertConfig: AlertConfig & { customHeaders?: MaskedHeader[] } | null }
      const config = data.alertConfig

      setPreset(detectPreset(config))
      setMaxLatencyMs(config?.maxLatencyMs ? String(config.maxLatencyMs) : '')

      // Keyword check
      if (config?.keywordCheck) {
        setKeywordType(config.keywordCheck.type)
        setKeywordValue(config.keywordCheck.value)
      }

      // Expected status codes
      if (config?.expectedStatusCodes && config.expectedStatusCodes.length > 0) {
        setExpectedStatusCodes(config.expectedStatusCodes.join(', '))
      }

      // HTTP method
      if (config?.httpMethod) {
        setHttpMethod(config.httpMethod)
      }

      // Custom headers (masked from API)
      if (config?.customHeaders && config.customHeaders.length > 0) {
        setExistingHeaders(config.customHeaders)
      }

      // Reminder interval
      if (config?.reminderIntervalMin) {
        setReminderIntervalMin(String(config.reminderIntervalMin))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load config')
    } finally {
      setIsLoading(false)
    }
  }, [monitorId])

  useEffect(() => { loadConfig() }, [loadConfig])

  // ── Validation ──────────────────────────────────────────────────────────────
  function validate(): boolean {
    const errors: Record<string, string> = {}

    // Validate expected status codes
    const statusError = validateStatusCodes(expectedStatusCodes)
    if (statusError) {
      errors.expectedStatusCodes = statusError
    }

    // Validate keyword
    const keywordError = validateKeyword(keywordValue)
    if (keywordError) {
      errors.keywordValue = keywordError
    }

    // Validate new header key
    if (newHeaderKey) {
      const keyError = validateHeaderKey(newHeaderKey)
      if (keyError) {
        errors.newHeaderKey = keyError
      }
    }

    // Validate new header value
    if (newHeaderKey && !newHeaderValue) {
      errors.newHeaderValue = 'Header value required'
    }

    // Validate total headers count
    const totalHeaders = existingHeaders.length + headers.length
    if (totalHeaders + (newHeaderKey ? 1 : 0) > 5) {
      errors.headers = 'Maximum 5 custom headers allowed'
    }

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  // ── Save handler ─────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!validate()) return

    setIsSaving(true)
    setError(null)
    setSaved(false)

    // Build alertConfig from UI state
    const presetDef = ALERT_PRESETS[preset]
    const latency = maxLatencyMs ? parseInt(maxLatencyMs, 10) : null

    // Parse expected status codes
    const expectedCodes = expectedStatusCodes
      ? expectedStatusCodes.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
      : undefined

    // Build keyword check
    const keywordCheck = keywordValue
      ? { type: keywordType, value: keywordValue }
      : undefined

    // Build custom headers (new ones with plaintext values)
    const customHeaders = headers.map((h) => ({
      key: h.key,
      valueEncrypted: h.value, // Will be encrypted by API
    }))

    const alertConfig: AlertConfig = {
      failStatusCodes:
        'failStatusCodes' in presetDef ? presetDef.failStatusCodes as number[] : undefined,
      maxLatencyMs: latency && !isNaN(latency) ? latency : null,
      keywordCheck,
      expectedStatusCodes: expectedCodes,
      httpMethod,
      customHeaders: customHeaders.length > 0 ? customHeaders : undefined,
      followRedirects: true,
      reminderIntervalMin: reminderIntervalMin ? Number(reminderIntervalMin) as 15 | 30 | 60 | 120 : null,
    }

    try {
      const res = await fetch(`/api/monitors/${monitorId}/config`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertConfig }),
      })

      const data = await res.json() as { ok?: boolean; error?: string }

      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to save config')
      }

      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      onSaved?.()

      // Clear new headers form
      setNewHeaderKey('')
      setNewHeaderValue('')

      // Reload to get masked headers
      await loadConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  // ── Header management ──────────────────────────────────────────────────────
  function addHeader() {
    if (!newHeaderKey || !newHeaderValue) return

    const keyError = validateHeaderKey(newHeaderKey)
    if (keyError) {
      setFieldErrors((prev) => ({ ...prev, newHeaderKey: keyError }))
      return
    }

    setHeaders((prev) => [...prev, { key: newHeaderKey, value: newHeaderValue }])
    setNewHeaderKey('')
    setNewHeaderValue('')
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next.newHeaderKey
      delete next.newHeaderValue
      return next
    })
  }

  function removeNewHeader(index: number) {
    setHeaders((prev) => prev.filter((_, i) => i !== index))
  }

  function removeExistingHeader(index: number) {
    setExistingHeaders((prev) => prev.filter((_, i) => i !== index))
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-c-soft" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-5">

      {/* Status code threshold */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-c-muted">
          Alert on
        </label>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as AlertPresetKey)}
          className="w-full rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                     focus:border-c-accent focus:outline-none focus:ring-0"
        >
          {(Object.keys(ALERT_PRESETS) as AlertPresetKey[]).map((key) => (
            <option key={key} value={key}>
              {ALERT_PRESETS[key].label}
            </option>
          ))}
        </select>
      </div>

      {/* Expected status codes */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-c-muted">
          Expected status codes
          <span className="ml-1 font-normal text-c-muted/70">optional — comma-separated</span>
        </label>
        <input
          type="text"
          placeholder="e.g. 200, 201, 204"
          value={expectedStatusCodes}
          onChange={(e) => setExpectedStatusCodes(e.target.value)}
          className="w-full rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                     placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none focus:ring-0"
        />
        {fieldErrors.expectedStatusCodes && (
          <p className="text-xs text-red-500">{fieldErrors.expectedStatusCodes}</p>
        )}
        <p className="text-xs text-c-muted/70">
          Only these codes are OK — anything else triggers alert
        </p>
      </div>

      {/* Latency threshold */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-c-muted">
          Max latency (ms)
          <span className="ml-1 font-normal text-c-muted/70">optional</span>
        </label>
        <input
          type="number"
          min={100}
          max={60000}
          step={100}
          placeholder="e.g. 3000"
          value={maxLatencyMs}
          onChange={(e) => setMaxLatencyMs(e.target.value)}
          className="w-full rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                     placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none focus:ring-0"
        />
        {maxLatencyMs && (
          <p className="text-xs text-c-muted/70">
            Alert when response takes longer than {Number(maxLatencyMs).toLocaleString()}ms
          </p>
        )}
      </div>

      {/* Keyword check */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-c-muted">
          Keyword check
          <span className="ml-1 font-normal text-c-muted/70">optional</span>
        </label>
        <div className="flex gap-2">
          <select
            value={keywordType}
            onChange={(e) => setKeywordType(e.target.value as 'should_contain' | 'should_not_contain')}
            className="w-40 rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                       focus:border-c-accent focus:outline-none focus:ring-0"
          >
            <option value="should_contain">Should contain</option>
            <option value="should_not_contain">Should not contain</option>
          </select>
          <input
            type="text"
            placeholder="e.g. Dashboard, Welcome"
            value={keywordValue}
            onChange={(e) => setKeywordValue(e.target.value)}
            maxLength={500}
            className="flex-1 rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                       placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none focus:ring-0"
          />
        </div>
        {fieldErrors.keywordValue && (
          <p className="text-xs text-red-500">{fieldErrors.keywordValue}</p>
        )}
        {keywordValue && (
          <p className="text-xs text-c-muted/70">
            {keywordType === 'should_contain'
              ? `Alert if response doesn't contain "${keywordValue}"`
              : `Alert if response contains "${keywordValue}"`}
          </p>
        )}
      </div>

      {/* HTTP Method */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-c-muted">
          HTTP method
        </label>
        <select
          value={httpMethod}
          onChange={(e) => setHttpMethod(e.target.value as 'GET' | 'HEAD')}
          className="w-full rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                     focus:border-c-accent focus:outline-none focus:ring-0"
        >
          <option value="GET">GET (full response)</option>
          <option value="HEAD">HEAD (headers only, faster)</option>
        </select>
        <p className="text-xs text-c-muted/70">
          HEAD is faster but doesn't support keyword checks
        </p>
      </div>

      {/* Reminder interval */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-c-muted">
          Downtime reminder
          <span className="ml-1 font-normal text-c-muted/70">optional</span>
        </label>
        <select
          value={reminderIntervalMin}
          onChange={(e) => setReminderIntervalMin(e.target.value)}
          className="w-full rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                     focus:border-c-accent focus:outline-none focus:ring-0"
        >
          <option value="">Disabled</option>
          <option value="15">Every 15 minutes</option>
          <option value="30">Every 30 minutes</option>
          <option value="60">Every 1 hour</option>
          <option value="120">Every 2 hours</option>
        </select>
        <p className="text-xs text-c-muted/70">
          Send reminder emails while site is down
        </p>
      </div>

      {/* Custom Headers */}
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-c-muted">
          Custom headers
          <span className="ml-1 font-normal text-c-muted/70">optional — max 5</span>
        </label>

        {/* Existing headers (masked) */}
        {existingHeaders.length > 0 && (
          <div className="space-y-2">
            {existingHeaders.map((header, i) => (
              <div key={`existing-${i}`} className="flex items-center gap-2">
                <code className="flex-1 rounded bg-c-soft px-2 py-1 text-xs text-c-muted">
                  {header.key}: {header.valueMasked}
                </code>
                <button
                  type="button"
                  onClick={() => removeExistingHeader(i)}
                  className="text-xs text-red-400 hover:text-red-600"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {/* New headers */}
        {headers.map((header, i) => (
          <div key={`new-${i}`} className="flex items-center gap-2">
            <code className="flex-1 rounded bg-c-soft px-2 py-1 text-xs text-c-muted">
              {header.key}: ***{header.value.slice(-4)}
            </code>
            <button
              type="button"
              onClick={() => removeNewHeader(i)}
              className="text-xs text-red-400 hover:text-red-600"
            >
              Remove
            </button>
          </div>
        ))}

        {/* Add new header */}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Key"
            value={newHeaderKey}
            onChange={(e) => setNewHeaderKey(e.target.value)}
            className="w-32 rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                       placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none focus:ring-0"
          />
          <input
            type="password"
            placeholder="Value"
            value={newHeaderValue}
            onChange={(e) => setNewHeaderValue(e.target.value)}
            className="flex-1 rounded-lg border border-c-line bg-c-card px-3 py-2 text-sm text-c-ink
                       placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none focus:ring-0"
          />
          <button
            type="button"
            onClick={addHeader}
            disabled={!newHeaderKey || !newHeaderValue}
            className="rounded-lg border border-c-line px-3 py-2 text-sm text-c-muted
                       hover:bg-c-soft disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {fieldErrors.newHeaderKey && (
          <p className="text-xs text-red-500">{fieldErrors.newHeaderKey}</p>
        )}
        {fieldErrors.newHeaderValue && (
          <p className="text-xs text-red-500">{fieldErrors.newHeaderValue}</p>
        )}
        {fieldErrors.headers && (
          <p className="text-xs text-red-500">{fieldErrors.headers}</p>
        )}
        <p className="text-xs text-c-muted/70">
          Values are encrypted at rest — only first use sends plaintext
        </p>
      </div>

      {/* Error */}
      {error && (
        <p className="text-xs text-red-500">{error}</p>
      )}

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={isSaving}
        className="flex items-center gap-2 rounded-lg bg-c-ink px-4 py-2 text-sm
                   font-medium text-c-brand-ink transition-opacity hover:opacity-80
                   disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSaving ? 'Saving…' : saved ? '✓ Saved' : 'Save settings'}
      </button>

    </div>
  )
}

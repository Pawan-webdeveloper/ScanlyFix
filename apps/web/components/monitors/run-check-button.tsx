'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  isLogRowNewer,
  runLogPoll,
  type LogBaseline,
  type LogRow,
} from './run-check-button-logic.ts'

/**
 * "Run check now" — Phase 7.3.
 *
 * "Run check now" — Phase 7.3.
 *
 * One button, four states the user can see:
 *
 *   idle      → "Run check"   (pill button, primary tone)
 *   running   → "Running…"    with a spinner, no border accent
 *   finished  → "Check complete" with a check, for ~2s, then idle
 *   error     → "Try again"   red, with the route's error sentence
 *
 * And one they cannot see, but the component does:
 *
 *   polling   → after POST 200, ask /logs every 600ms for up to 10s
 *               looking for a row newer than the click. As soon as one
 *               shows up, hand off to the parent (it re-fetches
 *               everything) and stop polling. If 10s pass without a
 *               new row, give up: the event was emitted, the queue
 *               may be slow, and the user has already seen enough
 *               of a spinner.
 *
 * ## Why poll, not push
 *
 * The probe writes to `monitor_events`, not to a websocket. A
 * websocket would mean running one per connected viewer, plus a
 * backchannel the user did not ask for. Polling an endpoint that
 * already serves the recent-checks table is one extra fetch every
 * 600ms — small, and the endpoint is read-heavy by design.
 *
 * ## Why the parent's `onChecked` is the success signal, not the response
 *
 * POST 200 means "we emitted the event". It does NOT mean "we wrote
 * a row". The row arrives whenever the Inngest worker picks the
 * event up, which is async and out of our control. The button's
 * job is to wait until a row actually lands, so the parent's
 * `setLogs` reflects what the user just triggered.
 *
 * The comparison + polling loop live in `run-check-button-logic.ts`
 * so they can be unit-tested without React.
 */

export interface RunCheckButtonProps {
  monitorId: string
  /** Called when a new log row has landed — the parent should re-fetch everything. */
  onChecked: () => void
  /**
   * Optional baseline: the id/ts of the newest row BEFORE the click.
   * If the caller has this cached (the parent already loaded logs),
   * it can pass it in and we use it to detect a new row in one fetch
   * without scanning the whole table.
   */
  baseline?: LogBaseline | null
}

type Phase = 'idle' | 'running' | 'finished' | 'error'

const POLL_INTERVAL_MS = 600
const POLL_TIMEOUT_MS = 10_000
const FINISHED_FLASH_MS = 2_000

export function RunCheckButton({ monitorId, onChecked, baseline = null }: RunCheckButtonProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  // The cancel handle is mutable — we read it inside an effect, so a
  // ref keeps the value stable without re-subscribing the interval.
  const cancelRef = useRef<(() => void) | null>(null)

  // Tear down any pending poll on unmount. Without this a late
  // setState after the user navigated away raises a "can't update
  // unmounted component" warning in dev and is wasted work in prod.
  useEffect(() => {
    return () => {
      cancelRef.current?.()
    }
  }, [])

  const handleClick = useCallback(async () => {
    if (phase === 'running') return
    setError(null)
    setPhase('running')

    try {
      const res = await fetch(`/api/monitors/${monitorId}/run`, { method: 'POST' })
      if (!res.ok) {
        const detail: unknown = await res.json().catch(() => null)
        const reason =
          detail && typeof detail === 'object' && 'error' in detail && typeof detail.error === 'string'
            ? detail.error
            : `Run failed (HTTP ${res.status}).`
        setError(reason)
        setPhase('error')
        return
      }
    } catch {
      setError('Could not reach the server. Check your connection.')
      setPhase('error')
      return
    }

    // The route returned 200 — the event is in the queue. Now poll
    // /logs until a row newer than the click appears, or the timer
    // runs out. The polling loop lives in the .logic.ts sibling so
    // it can be tested without React.
    const handle = runLogPoll({
      monitorId,
      baseline,
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
      now: () => Date.now(),
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      fetcher: async (url: string) => {
        const res = await fetch(url)
        if (!res.ok) return null
        return (await res.json()) as { logs?: LogRow[] }
      },
      onHit: () => {
        setPhase('finished')
        onChecked()
        setTimeout(() => {
          setPhase((current) => (current === 'finished' ? 'idle' : current))
        }, FINISHED_FLASH_MS)
      },
      onDeadline: () => {
        setPhase('finished')
        onChecked()
        setTimeout(() => {
          setPhase((current) => (current === 'finished' ? 'idle' : current))
        }, FINISHED_FLASH_MS)
      },
    })
    cancelRef.current = handle.cancel
  }, [monitorId, onChecked, baseline, phase])

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={phase === 'running'}
        aria-busy={phase === 'running'}
        className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-opacity ${
          phase === 'running'
            ? 'cursor-wait border border-c-line bg-c-card text-c-muted/70'
            : phase === 'finished'
              ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
              : phase === 'error'
                ? 'border border-red-200 bg-red-50 text-red-700 hover:bg-red-100'
                : 'border border-c-ink bg-c-ink text-c-brand-ink hover:opacity-90'
        } disabled:cursor-wait disabled:opacity-100`}
      >
        {phase === 'running' && <Spinner />}
        {phase === 'finished' && <Check />}
        {phase === 'error' && <Alert />}
        <span>
          {phase === 'running'
            ? 'Running…'
            : phase === 'finished'
              ? 'Check complete'
              : phase === 'error'
                ? 'Try again'
                : 'Run check'}
        </span>
      </button>
      {error !== null && phase === 'error' && (
        <span role="alert" className="text-xs text-red-500">
          {error}
        </span>
      )}
    </div>
  )
}

/* Re-export so consumers do not need to know about the split. */
export { isLogRowNewer } from './run-check-button-logic.ts'

/* -------------------------------------------------------------------------- */
/* Inline icons                                                               */
/* -------------------------------------------------------------------------- */

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      className="animate-spin"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round" />
    </svg>
  )
}

function Check() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path d="M5 12l5 5 9-11" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Alert() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

'use client'

import { useId, useRef } from 'react'
import Link from 'next/link'
import { useScanSubmit } from '@/components/scan/use-scan-submit.ts'
import { useSession } from '@/components/auth/supabase-context.ts'
import { ArrowRight, Globe } from './icons.tsx'

/**
 * The hero's URL field — the one thing this page exists to collect, and
 * therefore the one thing on it that must be unmistakable.
 *
 * Three signals say "a website address goes here", because on a surface with
 * two colours and no  corners, an outlined box on its own reads as just
 * another button: a visible label naming what to paste, a globe in a gutter
 * cell, and a placeholder in the exact shape of the answer. The field is drawn
 * at 2px against every other 1px edge in the hero, which is what makes it the
 * primary object rather than a peer of the secondary link beneath it.
 *
 * The gutter shows an icon and NOT a fixed `https://` prefix: normalizeScanTarget
 * accepts a bare domain and a full URL equally, so a hardcoded prefix would read
 * as `https://https://example.com` the moment somebody pastes a real address.
 *
 * Terminal styling, but the behaviour is the shared useScanSubmit: same
 * validation the API route re-runs, same server sentence on failure, same
 * destination. Only the paint is different.
 *
 * The error is black like everything else here. The hero has exactly two
 * colours in it and a red would be a third; the ▲ carries the severity that
 * colour would have, and it survives being read aloud.
 */

const LABEL = 'font-mono text-sm uppercase tracking-[0.16em]'

export function HeroScanForm() {
  const inputId = useId()
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const session = useSession()
  const isAuthenticated = session.data?.session?.user != null
  // Restore is now signed-out-only: a signed-in visitor is shown the dashboard
  // call-to-action below instead of this form, and a mounted-but-unrendered
  // form must not consume a stashed URL that /scan/start or the dashboard
  // scan form would otherwise reclaim — takePendingUrl is read-once.
  const { value, setValue, pending, error, submit } = useScanSubmit({
    restore: !isAuthenticated,
    inputRef,
    authState: { isAuthenticated, isLoading: session.isLoading },
  })

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const started = await submit()
    if (!started) inputRef.current?.focus()
  }

  // A signed-in visitor never sees the field: the form exists to earn the
  // account they already have, so for them it collapses to the one click
  // that matters — into the product. (After the hooks above, per React's
  // rules; the form below remains the render for everyone else.)
  if (isAuthenticated) {
    return <HeroDashboardCta email={session.data?.session?.user?.email ?? null} />
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label htmlFor={inputId} className={`mb-2.5 block text-hero-ink ${LABEL}`}>
        Paste your website URL
      </label>

      {/*
        The field and its action are one bordered object, the way a command and
        its execute key are. flex-wrap does the responsive work: on a phone the
        button takes a full-width row of its own INSIDE the border, which keeps
        it a single submit control rather than two that disagree.
      */}
      <div
        // Focus lands on the GROUP, the way it does on a browser's own address
        // bar: the field, its gutter and its action are one control, and an
        // outline drawn around the <input> alone doubles up against the border
        // two pixels away and reads as a rendering fault. The first ring is the
        // fill colour, so the ink ring outside it has a gap to breathe in.
        className="flex flex-wrap items-stretch border-2 border-hero-ink focus-within:shadow-[0_0_0_2px_var(--brand),0_0_0_4px_var(--hero-ink)]"
      >
        <span
          aria-hidden="true"
          className="flex w-12 shrink-0 items-center justify-center border-r border-hero-rule text-hero-ink-dim"
        >
          <Globe size={18} />
        </span>

        <input
          id={inputId}
          ref={inputRef}
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://your-site.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={pending}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          // Its own outline is suppressed because the group carries the ring.
          className="hero-input h-14 min-w-0 flex-1 basis-48 bg-transparent px-4 font-mono text-base text-hero-ink placeholder:text-hero-ink-dim focus-visible:outline-none disabled:opacity-60"
        />

        <button
          type="submit"
          disabled={pending}
          className={`flex h-14 w-full shrink-0 items-center justify-center gap-2 border-t-2 border-hero-ink
 bg-hero-ink px-7 font-medium text-hero-on-ink transition-colors duration-150
 hover:bg-transparent hover:text-hero-ink disabled:opacity-60
 sm:w-auto sm:border-t-0 sm:border-l-2 ${LABEL}`}
        >
          {pending ? 'Scanning…' : 'Scan now'}
          <ArrowRight size={16} />
        </button>
      </div>

      {/* Reserved height, so an error appearing cannot shift the row below it. */}
      <p
        id={errorId}
        role="alert"
        aria-live="polite"
        className={`mt-3 min-h-5 text-hero-ink ${LABEL}`}
      >
        {error ? `▲ ${error}` : ''}
      </p>

      <Link
        href="/#checks"
        className={`mt-1 inline-flex h-11 items-center border border-hero-ink px-6 text-hero-ink
 transition-colors duration-150 hover:bg-hero-ink hover:text-hero-on-ink ${LABEL}`}
      >
        Read the checks
      </Link>
    </form>
  )
}

/**
 * What the hero shows a signed-in visitor instead of the URL field.
 *
 * Same visual weight as the scan button it replaces — h-14, the 2px border,
 * inverted at rest — so the hero keeps exactly one primary object. The label
 * keeps the form's rhythm ("who this is for" above the action) and names the
 * account, which is the only personalisation the hero can afford without
 * breaking its two-colour rule.
 */
function HeroDashboardCta({ email }: { email: string | null }) {
  return (
    <div>
      <p className={`mb-2.5 block text-hero-ink ${LABEL}`}>
        {email ? `Signed in as ${email}` : 'You are signed in'}
      </p>

      <Link
        href="/dashboard"
        className={`flex h-14 w-full items-center justify-center gap-2 border-2 border-hero-ink
 bg-hero-ink px-7 font-medium text-hero-on-ink transition-colors duration-150
 hover:bg-transparent hover:text-hero-ink focus-visible:outline-none
 focus-visible:shadow-[0_0_0_2px_var(--brand),0_0_0_4px_var(--hero-ink)] sm:w-auto ${LABEL}`}
      >
        Go to dashboard
        <ArrowRight size={16} />
      </Link>

      <Link
        href="/#checks"
        className={`mt-1 inline-flex h-11 items-center border border-hero-ink px-6 text-hero-ink
 transition-colors duration-150 hover:bg-hero-ink hover:text-hero-on-ink ${LABEL}`}
      >
        Read the checks
      </Link>
    </div>
  )
}

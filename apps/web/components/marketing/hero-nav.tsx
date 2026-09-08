/**
 * The hero's nav band, as a client island.
 *
 * The nav is the one part of the hero whose CONTENT depends on who is looking:
 * a signed-out visitor gets "Sign in" and "Scan a site", a signed-in one gets
 * their account mark linking to the dashboard — the landing page's actions
 * are the ones they have already completed. The landing page is static by
 * design, so — exactly like the scan form below the headline — the nav reads
 * the session from a client-mounted SupabaseClientAuthProvider rather than
 * from the server.
 *
 * SSR caveat, same as the scan form's: the provider only exists on the
 * client, so the nav renders the signed-out markup until hydration, then
 * swaps in the signed-in version once the session resolves. The signed-out
 * markup IS the server HTML, so the two agree on first paint.
 */

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { LogoBadge } from '@/components/brand/logo.tsx'
import { SupabaseClientAuthProvider, useSession } from '@/components/auth/supabase-provider-client.tsx'

/** The nav links, a step up from LABEL so they read next to the bigger wordmark. */
const NAV_LABEL = 'font-mono text-sm uppercase tracking-[0.14em]'

/** Only destinations that exist. Adding a page is one line here. */
const NAV_LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/#checks', label: 'Checks' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/pricing', label: 'Pricing' },
]

/** The entry a signed-out visitor sees where a signed-in one sees the avatar. */
const SIGN_IN_LINK = { href: '/login', label: 'Sign in' } as const

export function HeroNavClient() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    // The signed-out nav, identical to the server HTML, so hydration moves
    // nothing for the anonymous majority of visitors.
    return <HeroNavView signedIn={false} email={null} />
  }

  return (
    <SupabaseClientAuthProvider>
      <HeroNavSession />
    </SupabaseClientAuthProvider>
  )
}

function HeroNavSession() {
  const session = useSession()
  const user = session.data?.session?.user ?? null
  return <HeroNavView signedIn={user != null} email={user?.email ?? null} />
}

function HeroNavView({ signedIn, email }: { signedIn: boolean; email: string | null }) {
  // Falls back to the wordmark's first letter when the account has no email
  // (a provider edge), so the mark is never an empty box.
  const initial = (email ?? 'scanlyfix').slice(0, 1).toUpperCase()

  return (
    <nav
      aria-label="Main"
      className="relative z-30 flex items-center gap-8 border-b border-hero-ink px-4 py-3 sm:px-8"
    >
      <Link href="/" className="flex items-center gap-2.5" aria-label="ScanlyFix — home">
        <LogoBadge size={42} />
        <span className="font-mono text-2xl font-semibold uppercase tracking-tight">scanlyfix</span>
      </Link>

      <div className="flex-1" />

      <ul className={`hidden items-center gap-9 md:flex ${NAV_LABEL}`}>
        {(signedIn ? NAV_LINKS : [...NAV_LINKS, SIGN_IN_LINK]).map(({ href, label }) => (
          <li key={href}>
            <Link href={href} className="hero-link relative">
              {label}
            </Link>
          </li>
        ))}
      </ul>

      {signedIn ? (
        // The account mark, standing where "Scan a site" stood: the nav's
        // right-hand action is whatever the visitor's next step is. Square
        // like everything else in the hero — a round avatar here would read
        // as a different product's chip.
        <Link
          href="/dashboard"
          aria-label={email ? `Signed in as ${email} — open dashboard` : 'Open dashboard'}
          title={email ?? undefined}
          className={`grid size-9 shrink-0 place-items-center border border-hero-ink font-mono text-sm
                      font-semibold uppercase transition-colors duration-150 hover:bg-hero-ink
                      hover:text-hero-on-ink focus-visible:outline-none
                      focus-visible:shadow-[0_0_0_2px_var(--brand),0_0_0_4px_var(--hero-ink)]`}
        >
          {initial}
        </Link>
      ) : (
        <a href="#scan" className={`hero-link relative hidden sm:inline ${NAV_LABEL}`}>
          Scan a site →
        </a>
      )}

      {/* A disclosure, not a scripted menu: it is a real button, it is keyboard
          operable, it closes on Escape, and it ships no JavaScript. */}
      <details className="hero-menu relative md:hidden">
        <summary
          aria-label="Open menu"
          className="flex size-8 cursor-pointer items-center justify-center border border-hero-ink"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 7h16" />
            <path d="M4 12h16" />
            <path d="M4 17h16" />
          </svg>
        </summary>
        <ul className={`absolute right-0 top-10 z-40 w-48 border border-hero-ink bg-brand ${NAV_LABEL}`}>
          {(signedIn
            ? [...NAV_LINKS, { href: '/dashboard', label: 'Dashboard →' }]
            : [...NAV_LINKS, SIGN_IN_LINK, { href: '/#scan', label: 'Scan a site →' }]
          ).map(({ href, label }) => (
            <li key={href} className="border-b border-hero-ink last:border-0">
              <Link href={href} className="block px-4 py-3">
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </details>
    </nav>
  )
}

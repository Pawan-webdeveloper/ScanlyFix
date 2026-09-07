'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import anime from 'animejs'
import { LogoLockup } from '@/components/brand/logo.tsx'
import { SignOutButton } from '@/components/auth/sign-out-button.tsx'
import { ThemeToggle } from './theme-toggle.tsx'
import { motionAllowed } from './motion.ts'
import { attachPressFeedback } from './motion.tsx'
import { Icon } from './icons.tsx'
import { NAV, type NavItem } from './nav.ts'

/** useLayoutEffect on the client (hidden state + first frame in one paint),
    useEffect on the server, where layout effects do nothing and warn. */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SidebarCounts {
  email: string
  plan: string
  sites: number
  scans: number
  repositories: number
  containers: number
  clouds: number
  domains: number
}

interface RailProps extends SidebarCounts {
  onNavigate?: () => void
}

// ─── Sidebar shell ─────────────────────────────────────────────────────────────

/**
 * The console's left rail.
 *
 * Theming: uses `--c-side*` tokens from globals.css so the rail adapts to
 * light / dark mode exactly the same way the dashboard cards do. The previous
 * hardcoded `#0f1117` made the sidebar permanently dark, breaking the
 * light-mode palette.
 *
 * On narrow screens it collapses behind a hamburger rather than shrinking
 * to icons — a 260 px rail on a 375 px viewport leaves no room for the page
 * it is navigating, and icon-only navigation is unreadable for the items that
 * are hardest to name.
 *
 * Motion: nav rows cascade in once per mount, the mobile drawer slides instead
 * of teleporting, every row answers a press. All motion goes through
 * motionAllowed(), so reduced-motion users get the same rail without the
 * choreography.
 */
export function Sidebar(props: SidebarCounts) {
  const [drawer, setDrawer] = useState<'closed' | 'open' | 'closing'>('closed')

  const openDrawer = useCallback(() => setDrawer('open'), [])
  const closeDrawer = useCallback(
    () => setDrawer((current) => (current === 'open' ? 'closing' : current)),
    [],
  )

  const panelRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLButtonElement>(null)

  useIsoLayoutEffect(() => {
    if (drawer === 'closed') return
    const panel = panelRef.current
    const backdrop = backdropRef.current
    if (!panel || !backdrop) return

    const finish = () => setDrawer('closed')

    if (drawer === 'open') {
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') closeDrawer()
      }
      window.addEventListener('keydown', onKey)
      if (motionAllowed()) {
        anime({ targets: panel, translateX: ['-100%', '0%'], duration: 300, easing: 'easeOutExpo' })
        anime({ targets: backdrop, opacity: [0, 1], duration: 220, easing: 'easeOutQuad' })
      }
      return () => window.removeEventListener('keydown', onKey)
    }

    if (motionAllowed()) {
      const slide = anime({
        targets: panel,
        translateX: '-100%',
        duration: 240,
        easing: 'easeInQuad',
        complete: finish,
      })
      anime({ targets: backdrop, opacity: 0, duration: 200, easing: 'easeInQuad' })
      return () => {
        slide.pause()
        anime.remove(panel)
        anime.remove(backdrop)
      }
    }
    finish()
  }, [drawer, closeDrawer])

  const rail = <Rail {...props} onNavigate={closeDrawer} />

  return (
    <>
      {/* Mobile hamburger — hidden on desktop */}
      <button
        type="button"
        onClick={openDrawer}
        aria-expanded={drawer === 'open'}
        aria-label="Open navigation"
        className="fixed left-3 top-3 z-40 grid h-9 w-9 place-items-center rounded-lg border border-c-line bg-c-card text-c-ink shadow-sm transition-colors hover:bg-c-soft lg:hidden"
      >
        <span aria-hidden="true" className="text-base leading-none">☰</span>
      </button>

      {/* Desktop static rail */}
      <aside
        className="console sticky top-0 hidden h-dvh w-[240px] shrink-0 border-r border-c-line bg-c-side lg:flex lg:flex-col"
      >
        {rail}
      </aside>

      {/* Mobile drawer */}
      {drawer !== 'closed' && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            ref={backdropRef}
            type="button"
            aria-label="Close navigation"
            onClick={closeDrawer}
            className="absolute inset-0 bg-black/40"
          />
          <div
            ref={panelRef}
            className="console absolute inset-y-0 left-0 flex w-[240px] flex-col border-r border-c-line bg-c-side shadow-xl"
          >
            {rail}
          </div>
        </div>
      )}
    </>
  )
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

/**
 * One rail, two hosts: the desktop aside and the mobile drawer each mount a
 * fresh copy. That is why the entrance cascade is a mount effect.
 */
function Rail({
  email,
  plan,
  sites,
  scans,
  repositories,
  containers,
  clouds,
  domains,
  onNavigate,
}: RailProps) {
  const pathname = usePathname()
  const railRef = useRef<HTMLDivElement>(null)

  const counts: Record<NonNullable<NavItem['count']>, number> = {
    sites,
    scans,
    repositories,
    containers,
    clouds,
    domains,
  }

  useIsoLayoutEffect(() => {
    const rail = railRef.current
    if (!rail || !motionAllowed()) return

    const rows = rail.querySelectorAll('[data-nav-row]')
    const animation = anime({
      targets: rows,
      opacity: [0, 1],
      translateX: [-6, 0],
      duration: 350,
      easing: 'easeOutQuad',
      delay: (_element: unknown, index: number) => index * 20,
    })

    const releaseFeedback = attachPressFeedback(rail)
    return () => {
      animation.pause()
      releaseFeedback()
    }
  }, [])

  /** Derive the avatar initial from email. */
  const initial = email.slice(0, 1).toUpperCase()
  /** Username part before the @. */
  const username = email.split('@')[0]

  return (
    <div
      ref={railRef}
      className="flex h-full flex-col overflow-hidden"
    >
      {/* ── Header: logo lockup ─────────────────────────── */}
      {/* Home is `/?home=1`, not `/`: a signed-in visit to `/` forwards to
          the dashboard (lib/homepage-redirect.ts), so the bare path would
          bounce this click straight back to where it started. The param is
          the escape hatch that shows the real marketing page. */}
      <Link
        href="/?home=1"
        onClick={onNavigate}
        data-press=""
        aria-label="Scanlyfix — home"
        className="flex items-center gap-2.5 border-b border-c-line px-4 py-[14px] transition-colors hover:bg-c-soft"
      >
        <LogoLockup size={26} word="Scanlyfix" tone="ink" />
      </Link>

      {/* ── Workspace chip ──────────────────────────────── */}
      <div className="px-3 pt-3">
        <button
          type="button"
          data-press=""
          className="flex w-full items-center gap-2.5 rounded-lg border border-c-line bg-c-card px-2.5 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-c-line/70 hover:bg-c-soft"
        >
          {/* Avatar */}
          <span
            aria-hidden="true"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-c-accent text-[11px] font-semibold text-white"
          >
            {initial}
          </span>
          {/* Name */}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-c-ink">
            {username}
          </span>
          {/* Chevron */}
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 text-c-muted"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {/* ── Nav ─────────────────────────────────────────── */}
      <nav
        aria-label="Console navigation"
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4"
      >
        {NAV.map((section) => (
          <div key={section.title} className="flex flex-col gap-0.5">
            {/* Section heading */}
            <p className="mb-1 px-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-c-muted/70">
              {section.title}
            </p>
            {section.items.map((item) => (
              <Row
                key={item.label}
                item={item}
                active={item.href ? pathname === item.href || pathname.startsWith(item.href) : false}
                count={item.count ? counts[item.count] : undefined}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* ── Footer ──────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t border-c-line px-3 py-3">
        {/* Upgrade CTA */}
        <Link
          href="/settings/billing"
          data-press=""
          className="flex h-8 items-center justify-center rounded-lg bg-c-accent text-[12.5px] font-semibold tracking-tight text-white shadow-[0_1px_3px_rgba(0,0,0,0.1)] transition-opacity hover:opacity-90"
        >
          Upgrade plan
        </Link>

        {/* User row */}
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-2">
          {/* Avatar */}
          <span
            aria-hidden="true"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-c-accent text-[11px] font-semibold text-white"
          >
            {initial}
          </span>
          {/* Email */}
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-[11.5px] font-medium text-c-ink"
              title={email}
            >
              {username}
            </p>
            <p className="truncate text-[10.5px] text-c-muted" title={email}>
              {plan}
            </p>
          </div>
          {/* Sign-out */}
          <SignOutButton
            className="shrink-0 text-[11px] text-c-muted transition-colors hover:text-c-ink"
          />
        </div>

        {/* Theme toggle */}
        <div className="flex justify-center pb-1">
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

/**
 * One nav row, in one of three states: active (current page), inactive
 * (navigable link), or soon (inert text with a badge).
 *
 * `soon` is deliberately a `<span>`, not a disabled `<a>`. A disabled anchor
 * is still focusable in some browsers and still reads as a link to screen
 * readers; a span with a badge says the same thing without the confusion.
 */
function Row({
  item,
  active,
  count,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  count?: number
  onNavigate?: () => void
}) {
  if (item.soon) {
    return (
      <span
        data-nav-row=""
        className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-c-muted/60"
      >
        <Icon name={item.icon} size={15} />
        <span className="flex-1">{item.label}</span>
        {count !== undefined && count > 0 ? (
          <span className="console-num rounded-md bg-c-soft px-1.5 py-px text-[10.5px] tabular-nums text-c-muted">
            {count}
          </span>
        ) : (
          <span className="rounded border border-c-line px-1.5 py-px text-[9.5px] font-medium uppercase tracking-[0.07em] text-c-muted/50">
            Soon
          </span>
        )}
      </span>
    )
  }

  return (
    <Link
      href={item.href ?? '#'}
      onClick={onNavigate}
      data-nav-row=""
      data-press=""
      aria-current={active ? 'page' : undefined}
      className={[
        'group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'bg-c-side-active text-c-side-ink'
          : 'text-c-muted hover:bg-c-soft hover:text-c-side-ink',
      ].join(' ')}
    >
      {/* Active accent bar */}
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-[2.5px] rounded-r bg-c-accent"
        />
      )}

      {/* Icon */}
      <Icon
        name={item.icon}
        size={15}
        className={active ? 'text-c-accent' : 'text-c-muted group-hover:text-c-side-ink'}
      />

      {/* Label */}
      <span className="flex-1">{item.label}</span>

      {/* Count badge */}
      {count !== undefined && count > 0 && (
        <span
          className={[
            'console-num rounded-md px-1.5 py-px text-[10.5px] tabular-nums',
            active
              ? 'bg-c-accent/15 text-c-accent'
              : 'bg-c-soft text-c-muted',
          ].join(' ')}
        >
          {count}
        </span>
      )}
    </Link>
  )
}

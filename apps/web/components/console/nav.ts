/**
 * What the console's sidebar lists, and which of it actually exists.
 *
 * Mirrors the checkvibe information architecture:
 *   MAIN       — high-level product surfaces
 *   ASSETS     — repos/containers/clouds/domains (counts from layout)
 *   MONITOR    — live threats, uptime (active), monitoring
 *   PROTECT    — runtime
 *   MORE       — integrations
 *
 * `soon: true` items are rendered as inert text with a badge, never a link,
 * because a nav row that looks clickable and does nothing is the worst option.
 */

import type { IconName } from './icons.tsx'

export interface NavItem {
  label: string
  icon: IconName
  /** Present only when the page exists. */
  href?: string
  /** Not built yet — rendered as inert text with a badge. */
  soon?: boolean
  /** Which count, if any, this row shows. Resolved by the sidebar's props. */
  count?: 'sites' | 'scans' | 'repositories' | 'containers' | 'clouds' | 'domains'
}

export interface NavSection {
  /** Heading above the group. MAIN has no heading — it sits under the workspace row. */
  title: string
  items: NavItem[]
}

export const NAV: readonly NavSection[] = [
  {
    title: 'MAIN',
    items: [
      { label: 'Dashboard', icon: 'home', href: '/dashboard' },
      { label: 'Feed', icon: 'feed', href: '/feed' },
      { label: 'AutoFix', icon: 'wrench', href: '/fixes' },
    ],
  },
  {
    title: 'ASSETS',
    items: [
      { label: 'Repositories', icon: 'repo', href: '/feed#repositories', count: 'repositories' },
      { label: 'Containers', icon: 'container', soon: true, count: 'containers' },
      { label: 'Clouds', icon: 'cloud', soon: true, count: 'clouds' },
      /*
       * The one asset class that is real today: a project IS a domain under
       * watch, so this row carries the live count rather than a "Soon" badge.
       *
       * The fragment is load-bearing, not decoration. Domains live in a section
       * of the dashboard rather than on a route of their own, and the sidebar
       * marks a row active by comparing `href` to the pathname — so a bare
       * '/dashboard' here lit BOTH this row and Dashboard at once.
       */
      { label: 'Domains', icon: 'globe', href: '/dashboard#sites', count: 'domains' },
    ],
  },
  {
    title: 'MONITOR',
    items: [
      { label: 'Live Threats', icon: 'threat', soon: true },
      { label: 'Uptime', icon: 'uptime', href: '/monitors' },
      { label: 'Monitoring', icon: 'bell', href: '/monitoring' },
    ],
  },
  {
    title: 'PROTECT',
    items: [{ label: 'Runtime', icon: 'shield', href: '/runtime' }],
  },
  {
    title: 'MORE',
    items: [{ label: 'Integrations', icon: 'plus', soon: true }],
  },
]

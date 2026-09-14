/**
 * Pure presentation logic for the Guard dashboard.
 *
 * Filtering, sorting and formatting live here rather than inside the table
 * component so they can be tested without rendering anything, and so the
 * component stays a description of the markup.
 */

import type { ClassifiedRoute } from './coverage';
import type { Enforcement, SessionProfile } from './classify';

export type RouteFilter = 'all' | 'needs_session' | 'attention' | 'public' | 'sample';
export type RouteSort = 'last_seen' | 'traffic' | 'pattern' | 'risk';

export const ROUTE_FILTER_LABEL: Readonly<Record<RouteFilter, string>> = {
  all: 'All',
  needs_session: 'Logged-in only',
  attention: 'Needs attention',
  public: 'Public',
  sample: 'Sample',
};

export const ROUTE_SORT_LABEL: Readonly<Record<RouteSort, string>> = {
  risk: 'Risk',
  last_seen: 'Last seen',
  traffic: 'Traffic',
  pattern: 'Path',
};

/** A route worth a second look: guarded inconsistently, waved through, or a mutation nothing can test. */
export function needsAttention(route: ClassifiedRoute): boolean {
  if (route.source === 'sample') return false;
  const { verdict } = route;
  const isLoggedInSurface = verdict.sessionProfile === 'session_only' || verdict.sessionProfile === 'mixed';
  if (isLoggedInSurface && (verdict.enforcement === 'unenforced' || verdict.enforcement === 'inconsistent')) return true;
  return verdict.needsSession && !verdict.probeable;
}

export function matchesFilter(route: ClassifiedRoute, filter: RouteFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs_session':
      return route.verdict.needsSession;
    case 'attention':
      return needsAttention(route);
    case 'public':
      return route.verdict.sessionProfile === 'public';
    case 'sample':
      return route.source === 'sample';
  }
}

export function matchesSearch(route: ClassifiedRoute, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return route.pattern.toLowerCase().includes(q) || route.method.toLowerCase().includes(q);
}

/** Worst-first ordering, used by the default "Risk" sort. */
const RISK_RANK: Readonly<Record<Enforcement, number>> = {
  unenforced: 0,
  inconsistent: 1,
  unknown: 2,
  enforced: 3,
};

const PROFILE_RANK: Readonly<Record<SessionProfile, number>> = {
  session_only: 0,
  mixed: 1,
  unknown: 2,
  public: 3,
};

function riskScore(route: ClassifiedRoute): number {
  if (route.source === 'sample') return 100;
  const { verdict } = route;
  const isLoggedInSurface = verdict.sessionProfile === 'session_only' || verdict.sessionProfile === 'mixed';
  // Enforcement problems on a logged-in surface come first; then unverifiable
  // mutations; then everything else by how session-bound it looks.
  if (isLoggedInSurface) {
    const rank = RISK_RANK[verdict.enforcement];
    if (rank <= 1) return rank;
  }
  if (verdict.needsSession && !verdict.probeable) return 2;
  return 3 + PROFILE_RANK[verdict.sessionProfile];
}

function timeOf(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function sortRoutes<T extends ClassifiedRoute>(routes: ReadonlyArray<T>, sort: RouteSort): T[] {
  const copy = [...routes];
  switch (sort) {
    case 'pattern':
      return copy.sort((a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method));
    case 'traffic':
      return copy.sort((a, b) => b.verdict.total - a.verdict.total || a.pattern.localeCompare(b.pattern));
    case 'last_seen':
      return copy.sort((a, b) => timeOf(b.lastSeenAt) - timeOf(a.lastSeenAt) || a.pattern.localeCompare(b.pattern));
    case 'risk':
      return copy.sort(
        (a, b) =>
          riskScore(a) - riskScore(b) || b.verdict.total - a.verdict.total || a.pattern.localeCompare(b.pattern),
      );
  }
}

export function filterAndSortRoutes<T extends ClassifiedRoute>(
  routes: ReadonlyArray<T>,
  options: { filter?: RouteFilter; search?: string; sort?: RouteSort } = {},
): T[] {
  const filter = options.filter ?? 'all';
  const search = options.search ?? '';
  const sort = options.sort ?? 'risk';
  return sortRoutes(
    routes.filter((r) => matchesFilter(r, filter) && matchesSearch(r, search)),
    sort,
  );
}

/** Compact relative time — "3m ago", "5h ago", "2d ago". */
export function formatRelativeTime(value: Date | string | null | undefined, now: Date = new Date()): string {
  const t = timeOf(value);
  if (t === 0) return '—';
  const minutes = Math.floor((now.getTime() - t) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Whole-percent share of requests that carried a session. */
export function sessionPct(route: ClassifiedRoute): number {
  if (route.verdict.total === 0) return 0;
  return Math.round((route.withSession / route.verdict.total) * 100);
}

/** A route first seen inside this window is badged "new". */
export const NEW_ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isNewRoute(route: ClassifiedRoute, now: Date = new Date()): boolean {
  const t = timeOf(route.firstSeenAt);
  return t > 0 && now.getTime() - t < NEW_ROUTE_WINDOW_MS;
}

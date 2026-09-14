/**
 * What observed traffic says about a route — on two independent axes.
 *
 * Keeping them separate is the whole design. Guard watches requests at the
 * edge, BEFORE the application's auth check runs, so the two questions have
 * different evidence behind them and must never be collapsed into one badge:
 *
 *   sessionProfile — what the traffic mix says the route is FOR. A route whose
 *                    requests almost always carry a session cookie is a
 *                    logged-in surface. This is an inference from behaviour,
 *                    and it is what decides whether the nightly prober should
 *                    watch the route.
 *
 *   enforcement    — what the wrapped middleware actually DID to the logged-out
 *                    requests it saw. This is not an inference: a 401/403 or a
 *                    redirect to a sign-in page is the middleware turning the
 *                    request away, recorded as it happened.
 *
 * A route can be a logged-in surface (`session_only`) whose enforcement is
 * `unknown` — perfectly normal when auth lives in the route handler rather than
 * in middleware. That combination is a reason to probe it, not a finding.
 */

import { categorizePath, CATEGORY_LABEL } from '../auth-prober/targets';
import type { TargetCategory } from '../auth-prober/types';

export type SessionProfile = 'session_only' | 'mixed' | 'public' | 'unknown';
export type Enforcement = 'enforced' | 'inconsistent' | 'unenforced' | 'unknown';

/** At or below this share of SERVED requests being anonymous, a route reads as a logged-in surface. */
export const SESSION_ONLY_MAX_OPEN_RATIO = 0.05;
/** At or above this share of SERVED requests being anonymous, a route reads as genuinely public. */
export const PUBLIC_MIN_OPEN_RATIO = 0.6;
/** Fewer samples than this is not data — no verdict is offered. */
export const MIN_SAMPLES = 3;
/**
 * A single logged-out request slipping through is the shape of a deploy
 * window, not of a matcher gap. Two or more is a pattern.
 */
export const MIN_PASSES_FOR_INCONSISTENT = 2;

/** The observed traffic counters a verdict is computed from. */
export type RouteTraffic = {
  withSession: number;
  withoutSession: number;
  /** Subset of withoutSession the middleware turned away. Absent on rows recorded before outcomes existed. */
  withoutSessionBlocked?: number | null;
  /** Subset of withoutSession the middleware waved through. */
  withoutSessionPassed?: number | null;
};

export type RouteIdentity = {
  pattern: string;
  method: string;
  kind: string;
  source?: string | null;
  lastSeenAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
};

/**
 * Anonymous requests the application actually SERVED.
 *
 * This correction is what makes the traffic mix mean anything. Guard observes
 * at the edge, before auth, so every protected route records anonymous
 * requests — bots, stale links, expired sessions — and on a healthy app the
 * middleware turns all of them away. Counting those against the route would
 * classify a perfectly guarded /dashboard as "mixed traffic" purely because
 * strangers knocked on it, and it would then never be handed to the prober.
 *
 * A request the middleware blocked never reached the application, so it is not
 * evidence that the route serves anonymous visitors. Requests whose outcome was
 * not observed are still counted, because assuming they were blocked would
 * flatter the numbers.
 */
export function servedAnonymous(traffic: RouteTraffic): number {
  const blocked = traffic.withoutSessionBlocked ?? 0;
  return Math.max(0, traffic.withoutSession - blocked);
}

/** Share of SERVED requests that carried no session. 0 when nothing was served. */
export function openRatio(traffic: RouteTraffic): number {
  const served = servedAnonymous(traffic);
  const total = traffic.withSession + served;
  if (total <= 0) return 0;
  return served / total;
}

/** Raw observation count, used only to decide whether there is enough data at all. */
export function totalRequests(traffic: RouteTraffic): number {
  return traffic.withSession + traffic.withoutSession;
}

/**
 * Axis 1 — what the traffic mix says this route is for, measured over the
 * requests the application actually served (see servedAnonymous).
 */
export function classifySessionProfile(traffic: RouteTraffic): SessionProfile {
  const total = totalRequests(traffic);
  if (total < MIN_SAMPLES) return 'unknown';
  const ratio = openRatio(traffic);
  if (ratio <= SESSION_ONLY_MAX_OPEN_RATIO) return 'session_only';
  if (ratio >= PUBLIC_MIN_OPEN_RATIO) return 'public';
  return 'mixed';
}

/** Axis 2 — what the wrapped middleware did to the logged-out requests it saw. */
export function classifyEnforcement(traffic: RouteTraffic): Enforcement {
  const blocked = traffic.withoutSessionBlocked ?? 0;
  const passed = traffic.withoutSessionPassed ?? 0;
  if (blocked + passed === 0) return 'unknown'; // no middleware wrapped, or pre-outcome rows
  if (passed === 0) return 'enforced';
  if (blocked === 0) return 'unenforced';
  return passed >= MIN_PASSES_FOR_INCONSISTENT ? 'inconsistent' : 'enforced';
}

/** How stale an inventory entry may get before its prober target is suspect. */
export const MAX_ROUTE_STALENESS_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function daysSince(date: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

export function isStale(lastSeenAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  const age = daysSince(lastSeenAt, now);
  return age !== null && age > MAX_ROUTE_STALENESS_DAYS;
}

/**
 * The prober sends logged-out GET requests and nothing else. A route it cannot
 * express is not a gap in the prober — it is a surface the developer has to
 * check by hand, and saying so is more useful than omitting it silently.
 */
export function isProbeable(route: RouteIdentity): boolean {
  return route.method.toUpperCase() === 'GET' && route.kind !== 'server_action';
}

/** Sample traffic is seeded for demonstration; it must never drive a real action. */
export function isSampleRoute(route: RouteIdentity): boolean {
  return route.source === 'sample';
}

export type RouteVerdict = {
  sessionProfile: SessionProfile;
  enforcement: Enforcement;
  category: TargetCategory;
  categoryLabel: string;
  total: number;
  openRatio: number;
  /** True when the traffic mix marks this as a logged-in surface worth watching. */
  needsSession: boolean;
  /** True when the nightly prober is able to express this route at all. */
  probeable: boolean;
  /** True when this route should be synced to the prober (real, fresh, probeable, logged-in). */
  syncEligible: boolean;
  stale: boolean;
  ageDays: number | null;
};

/**
 * One route's full verdict. Pure: same inputs, same answer, no clock unless
 * one is supplied.
 */
export function classifyRoute(
  route: RouteIdentity & RouteTraffic,
  options: { now?: Date } = {},
): RouteVerdict {
  const now = options.now ?? new Date();
  const sessionProfile = classifySessionProfile(route);
  const enforcement = classifyEnforcement(route);
  const category = categorizePath(route.pattern);
  const probeable = isProbeable(route);
  const stale = isStale(route.lastSeenAt, now);
  const needsSession = sessionProfile === 'session_only';

  return {
    sessionProfile,
    enforcement,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    total: totalRequests(route),
    openRatio: openRatio(route),
    needsSession,
    probeable,
    syncEligible: needsSession && probeable && !isSampleRoute(route) && !stale,
    stale,
    ageDays: daysSince(route.lastSeenAt, now),
  };
}

export const SESSION_PROFILE_LABEL: Readonly<Record<SessionProfile, string>> = {
  session_only: 'Logged-in only',
  mixed: 'Mixed traffic',
  public: 'Public',
  unknown: 'Not enough data',
};

export const ENFORCEMENT_LABEL: Readonly<Record<Enforcement, string>> = {
  enforced: 'Blocked at the edge',
  inconsistent: 'Inconsistent',
  unenforced: 'Passed through',
  unknown: 'Not observed',
};

export const ENFORCEMENT_HINT: Readonly<Record<Enforcement, string>> = {
  enforced: 'Every logged-out request was turned away by your middleware (401/403 or a redirect to sign-in).',
  inconsistent:
    'Logged-out requests to this route were sometimes turned away and sometimes let through — the guard does not cover every path to it.',
  unenforced:
    'Logged-out requests were waved through your middleware. Auth may still run in the route handler; the nightly prober checks whether it does.',
  unknown:
    'No middleware decision was observed. Wrap your auth middleware with withGuard(myMiddleware) to record what it does with logged-out requests.',
};

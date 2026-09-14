/**
 * Coverage — the one number that answers "is anything watching my protected
 * routes?"
 *
 * Guard knows which routes behave like logged-in surfaces. The Auth Prober
 * knows which paths it tests every night. The interesting quantity is the
 * difference: a route your users reach only when signed in, that nothing
 * verifies is still refusing anonymous visitors. That gap is invisible in
 * either feature alone.
 *
 * Routes the prober cannot express at all (POST endpoints, server actions) are
 * counted separately rather than folded into the percentage — they are not a
 * coverage failure, they are a surface that needs a human.
 */

import { classifyRoute, type RouteIdentity, type RouteTraffic, type RouteVerdict } from './classify';

export type GuardRouteInput = RouteIdentity & RouteTraffic & { id?: string };

export type ClassifiedRoute<T extends GuardRouteInput = GuardRouteInput> = T & { verdict: RouteVerdict };

export type GuardCoverage = {
  /** Every route in the inventory, sample rows included. */
  totalRoutes: number;
  /** Rows seeded by "Simulate sample traffic" — displayed, never acted on. */
  sampleRoutes: number;
  sessionOnly: number;
  mixed: number;
  publicRoutes: number;
  unknownProfile: number;
  /** Logged-in surfaces the prober is able to test (real, fresh, GET, not a server action). */
  probeEligible: number;
  /** Of those, how many are already prober targets. */
  probed: number;
  /** Of those, how many are not. This is the number that matters. */
  unprobed: number;
  /** Logged-in surfaces the prober can never express — POST routes and server actions. */
  unverifiable: number;
  /** probed / probeEligible as a whole percentage. 100 when there is nothing to cover. */
  coveragePct: number;
  /**
   * Enforcement counters cover LOGGED-IN SURFACES ONLY (session_only or mixed),
   * excluding sample rows. A public page whose middleware lets anonymous
   * visitors through is not "unenforced" in any sense a reader would mean.
   */
  enforced: number;
  unenforced: number;
  inconsistent: number;
  enforcementUnknown: number;
  /**
   * True when NO route anywhere carried a middleware decision — i.e. withGuard()
   * was called without a middleware to observe. Computed over every route,
   * because one observed decision anywhere proves the wrapper is in place.
   */
  outcomeDataMissing: boolean;
  lastSeenAt: Date | null;
};

/** Normalises a prober target path for comparison with a guard route pattern. */
export function targetKey(path: string): string {
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailing = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
  return withoutTrailing.toLowerCase();
}

export function buildTargetSet(targetPaths: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(targetPaths.map(targetKey));
}

export function classifyRoutes<T extends GuardRouteInput>(
  routes: ReadonlyArray<T>,
  options: { now?: Date } = {},
): Array<ClassifiedRoute<T>> {
  return routes.map((route) => ({ ...route, verdict: classifyRoute(route, options) }));
}

/** Is this classified route already watched by the nightly prober? */
export function isProbed(route: ClassifiedRoute, targets: ReadonlySet<string>): boolean {
  return targets.has(targetKey(route.pattern));
}

export function computeCoverage(
  routes: ReadonlyArray<ClassifiedRoute>,
  targets: ReadonlySet<string>,
): GuardCoverage {
  const coverage: GuardCoverage = {
    totalRoutes: routes.length,
    sampleRoutes: 0,
    sessionOnly: 0,
    mixed: 0,
    publicRoutes: 0,
    unknownProfile: 0,
    probeEligible: 0,
    probed: 0,
    unprobed: 0,
    unverifiable: 0,
    coveragePct: 100,
    enforced: 0,
    unenforced: 0,
    inconsistent: 0,
    enforcementUnknown: 0,
    outcomeDataMissing: true,
    lastSeenAt: null,
  };

  for (const route of routes) {
    const { verdict } = route;
    if (route.source === 'sample') coverage.sampleRoutes++;

    switch (verdict.sessionProfile) {
      case 'session_only':
        coverage.sessionOnly++;
        break;
      case 'mixed':
        coverage.mixed++;
        break;
      case 'public':
        coverage.publicRoutes++;
        break;
      case 'unknown':
        coverage.unknownProfile++;
        break;
    }

    // One observed decision anywhere proves the middleware is wrapped.
    if (verdict.enforcement !== 'unknown') coverage.outcomeDataMissing = false;

    const isLoggedInSurface = verdict.sessionProfile === 'session_only' || verdict.sessionProfile === 'mixed';
    if (isLoggedInSurface && route.source !== 'sample') {
      switch (verdict.enforcement) {
        case 'enforced':
          coverage.enforced++;
          break;
        case 'unenforced':
          coverage.unenforced++;
          break;
        case 'inconsistent':
          coverage.inconsistent++;
          break;
        case 'unknown':
          coverage.enforcementUnknown++;
          break;
      }
    }

    // Sample rows are displayed honestly but never counted as real coverage.
    if (verdict.needsSession && route.source !== 'sample') {
      if (verdict.probeable) {
        coverage.probeEligible++;
        if (isProbed(route, targets)) coverage.probed++;
        else coverage.unprobed++;
      } else {
        coverage.unverifiable++;
      }
    }

    if (route.lastSeenAt) {
      const seen = new Date(route.lastSeenAt);
      if (!Number.isNaN(seen.getTime()) && (!coverage.lastSeenAt || seen > coverage.lastSeenAt)) {
        coverage.lastSeenAt = seen;
      }
    }
  }

  coverage.coveragePct =
    coverage.probeEligible === 0 ? 100 : Math.round((coverage.probed / coverage.probeEligible) * 100);

  return coverage;
}

/** Headline wording for the coverage number, so the UI and emails agree. */
export function coverageTone(coverage: GuardCoverage): 'good' | 'warn' | 'bad' {
  if (coverage.probeEligible === 0) return 'good';
  if (coverage.coveragePct >= 90) return 'good';
  if (coverage.coveragePct >= 50) return 'warn';
  return 'bad';
}

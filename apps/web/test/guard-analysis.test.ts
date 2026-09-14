import { describe, expect, it } from 'vitest';

import {
  classifyEnforcement,
  classifyRoute,
  classifySessionProfile,
  daysSince,
  isProbeable,
  isStale,
  MIN_PASSES_FOR_INCONSISTENT,
  openRatio,
  servedAnonymous,
} from '../lib/runtime/guard/classify.ts';
import {
  buildTargetSet,
  classifyRoutes,
  computeCoverage,
  coverageTone,
  isProbed,
  targetKey,
  type ClassifiedRoute,
  type GuardRouteInput,
} from '../lib/runtime/guard/coverage.ts';
import {
  filterAndSortRoutes,
  formatRelativeTime,
  isNewRoute,
  matchesFilter,
  matchesSearch,
  needsAttention,
  sessionPct,
  sortRoutes,
} from '../lib/runtime/guard/view.ts';

const NOW = new Date('2026-09-14T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function route(overrides: Partial<GuardRouteInput> = {}): GuardRouteInput {
  return {
    id: overrides.pattern ?? 'r1',
    pattern: '/dashboard',
    method: 'GET',
    kind: 'route',
    source: null,
    withSession: 50,
    withoutSession: 1,
    withoutSessionBlocked: 0,
    withoutSessionPassed: 0,
    firstSeenAt: daysAgo(30),
    lastSeenAt: daysAgo(1),
    ...overrides,
  };
}

const classify = (overrides: Partial<GuardRouteInput> = {}): ClassifiedRoute => ({
  ...route(overrides),
  verdict: classifyRoute(route(overrides), { now: NOW }),
});

describe('guard classify — session profile (what the route is for)', () => {
  it('reads an almost-always-signed-in route as a logged-in surface', () => {
    expect(classifySessionProfile({ withSession: 50, withoutSession: 0 })).toBe('session_only');
    expect(classifySessionProfile({ withSession: 96, withoutSession: 4 })).toBe('session_only'); // exactly 4%
    expect(classifySessionProfile({ withSession: 3, withoutSession: 0 })).toBe('session_only'); // min samples
  });

  it('reads mostly-anonymous traffic as public', () => {
    expect(classifySessionProfile({ withSession: 4, withoutSession: 88 })).toBe('public');
    expect(classifySessionProfile({ withSession: 40, withoutSession: 60 })).toBe('public'); // exactly 60%
  });

  it('reads the middle as mixed rather than forcing a side', () => {
    expect(classifySessionProfile({ withSession: 90, withoutSession: 10 })).toBe('mixed');
    expect(classifySessionProfile({ withSession: 50, withoutSession: 30 })).toBe('mixed');
  });

  it('refuses to guess below three samples', () => {
    expect(classifySessionProfile({ withSession: 2, withoutSession: 0 })).toBe('unknown');
    expect(classifySessionProfile({ withSession: 0, withoutSession: 0 })).toBe('unknown');
  });

  it('openRatio never divides by zero', () => {
    expect(openRatio({ withSession: 0, withoutSession: 0 })).toBe(0);
    expect(openRatio({ withSession: 1, withoutSession: 3 })).toBe(0.75);
  });

  it('ignores anonymous requests the middleware turned away — they never reached the app', () => {
    // A well-guarded /dashboard: strangers knock, the middleware sends them to
    // sign-in. Counting those would class it "mixed" and it would never be probed.
    expect(servedAnonymous({ withSession: 20, withoutSession: 6, withoutSessionBlocked: 6 })).toBe(0);
    expect(openRatio({ withSession: 20, withoutSession: 6, withoutSessionBlocked: 6 })).toBe(0);
    expect(classifySessionProfile({ withSession: 20, withoutSession: 6, withoutSessionBlocked: 6 })).toBe('session_only');

    // The ones that got through still count in full.
    expect(servedAnonymous({ withSession: 12, withoutSession: 5, withoutSessionPassed: 5 })).toBe(5);
    expect(classifySessionProfile({ withSession: 12, withoutSession: 5, withoutSessionPassed: 5 })).toBe('mixed');

    // Without outcome data nothing is assumed — the raw ratio stands.
    expect(classifySessionProfile({ withSession: 20, withoutSession: 6 })).toBe('mixed');
  });
});

describe('guard classify — enforcement (what the middleware actually did)', () => {
  it('says nothing when no middleware decision was recorded', () => {
    expect(classifyEnforcement({ withSession: 9, withoutSession: 9 })).toBe('unknown');
    expect(classifyEnforcement({ withSession: 9, withoutSession: 9, withoutSessionBlocked: 0, withoutSessionPassed: 0 })).toBe(
      'unknown',
    );
  });

  it('calls it enforced when every logged-out request was turned away', () => {
    expect(classifyEnforcement({ withSession: 9, withoutSession: 7, withoutSessionBlocked: 7, withoutSessionPassed: 0 })).toBe(
      'enforced',
    );
  });

  it('calls it unenforced when every logged-out request was waved through', () => {
    expect(classifyEnforcement({ withSession: 9, withoutSession: 4, withoutSessionBlocked: 0, withoutSessionPassed: 4 })).toBe(
      'unenforced',
    );
  });

  it('calls it inconsistent only once the pass-throughs are a pattern, not a blip', () => {
    // One pass-through inside a deploy window is noise.
    expect(classifyEnforcement({ withSession: 9, withoutSession: 21, withoutSessionBlocked: 20, withoutSessionPassed: 1 })).toBe(
      'enforced',
    );
    expect(MIN_PASSES_FOR_INCONSISTENT).toBe(2);
    expect(classifyEnforcement({ withSession: 9, withoutSession: 22, withoutSessionBlocked: 20, withoutSessionPassed: 2 })).toBe(
      'inconsistent',
    );
  });

  it('treats a missing breakdown as no data, not as zero pass-throughs', () => {
    expect(classifyEnforcement({ withSession: 5, withoutSession: 5, withoutSessionBlocked: null, withoutSessionPassed: null })).toBe(
      'unknown',
    );
  });
});

describe('guard classify — the two axes stay independent', () => {
  it('a logged-in surface with no middleware data is not a finding, just unprobed evidence', () => {
    const v = classifyRoute(route({ withSession: 60, withoutSession: 0 }), { now: NOW });
    expect(v.sessionProfile).toBe('session_only');
    expect(v.enforcement).toBe('unknown');
    expect(v.needsSession).toBe(true);
    expect(v.syncEligible).toBe(true);
  });

  it('a route that turns every anonymous visitor away is a logged-in surface, however many knock', () => {
    const v = classifyRoute(
      route({ withSession: 2, withoutSession: 98, withoutSessionBlocked: 98, withoutSessionPassed: 0 }),
      { now: NOW },
    );
    expect(v.sessionProfile).toBe('session_only');
    expect(v.enforcement).toBe('enforced');
    expect(v.needsSession).toBe(true);
  });

  it('derives the route category from the path', () => {
    expect(classifyRoute(route({ pattern: '/admin/users' }), { now: NOW }).category).toBe('admin');
    expect(classifyRoute(route({ pattern: '/api/orders' }), { now: NOW }).category).toBe('api');
    expect(classifyRoute(route({ pattern: '/actuator/env' }), { now: NOW }).category).toBe('debug');
    expect(classifyRoute(route({ pattern: '/dashboard' }), { now: NOW }).category).toBe('auth_page');
  });
});

describe('guard classify — probeability and staleness', () => {
  it('only GET routes that are not server actions can be probed', () => {
    expect(isProbeable({ pattern: '/a', method: 'GET', kind: 'route' })).toBe(true);
    expect(isProbeable({ pattern: '/a', method: 'get', kind: 'route' })).toBe(true);
    expect(isProbeable({ pattern: '/a', method: 'POST', kind: 'route' })).toBe(false);
    expect(isProbeable({ pattern: '/a', method: 'GET', kind: 'server_action' })).toBe(false);
  });

  it('marks a route stale past the two-week cutoff', () => {
    expect(isStale(daysAgo(13), NOW)).toBe(false);
    expect(isStale(daysAgo(14), NOW)).toBe(false);
    expect(isStale(daysAgo(15), NOW)).toBe(true);
    expect(isStale(null, NOW)).toBe(false);
    expect(isStale('not a date', NOW)).toBe(false);
  });

  it('daysSince clamps to zero and survives bad input', () => {
    expect(daysSince(daysAgo(3), NOW)).toBe(3);
    expect(daysSince(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
    expect(daysSince(undefined, NOW)).toBeNull();
  });

  it('never syncs sample traffic or stale routes', () => {
    expect(classifyRoute(route({ source: 'sample' }), { now: NOW }).syncEligible).toBe(false);
    expect(classifyRoute(route({ lastSeenAt: daysAgo(40) }), { now: NOW }).syncEligible).toBe(false);
    expect(classifyRoute(route({ method: 'POST' }), { now: NOW }).syncEligible).toBe(false);
  });
});

describe('guard coverage', () => {
  it('normalises paths before matching a route against a prober target', () => {
    expect(targetKey('dashboard')).toBe('/dashboard');
    expect(targetKey('/Dashboard/')).toBe('/dashboard');
    expect(targetKey('/')).toBe('/');
    expect(targetKey('  /api/users/[id]  ')).toBe('/api/users/[id]');
  });

  it('matches a guard pattern to a prober target through that normalisation', () => {
    const targets = buildTargetSet(['/Dashboard/', '/api/users/[id]']);
    expect(isProbed(classify({ pattern: '/dashboard' }), targets)).toBe(true);
    expect(isProbed(classify({ pattern: '/api/users/[id]' }), targets)).toBe(true);
    expect(isProbed(classify({ pattern: '/admin' }), targets)).toBe(false);
  });

  it('counts coverage over probe-eligible routes only, and reports the rest separately', () => {
    const routes = classifyRoutes(
      [
        route({ pattern: '/dashboard', withSession: 50, withoutSession: 0 }), // logged-in, probed
        route({ pattern: '/admin', withSession: 30, withoutSession: 1 }), // logged-in, NOT probed
        route({ pattern: '/api/save', method: 'POST', withSession: 20, withoutSession: 0 }), // unverifiable
        route({ pattern: '/act', kind: 'server_action', method: 'POST', withSession: 20, withoutSession: 0 }), // unverifiable
        route({ pattern: '/pricing', withSession: 2, withoutSession: 98 }), // public
        route({ pattern: '/new', withSession: 1, withoutSession: 0 }), // not enough data
        route({ pattern: '/demo', source: 'sample', withSession: 40, withoutSession: 0 }), // sample
      ],
      { now: NOW },
    );
    const coverage = computeCoverage(routes, buildTargetSet(['/dashboard']));

    expect(coverage.totalRoutes).toBe(7);
    expect(coverage.sampleRoutes).toBe(1);
    expect(coverage.publicRoutes).toBe(1);
    expect(coverage.unknownProfile).toBe(1);
    // /dashboard, /admin, /api/save, /act, /demo all read as logged-in surfaces…
    expect(coverage.sessionOnly).toBe(5);
    // …but only the real, probeable ones count toward coverage.
    expect(coverage.probeEligible).toBe(2);
    expect(coverage.probed).toBe(1);
    expect(coverage.unprobed).toBe(1);
    expect(coverage.unverifiable).toBe(2);
    expect(coverage.coveragePct).toBe(50);
  });

  it('reports 100% when there is nothing to cover, and flags missing outcome data', () => {
    const routes = classifyRoutes([route({ pattern: '/pricing', withSession: 1, withoutSession: 99 })], { now: NOW });
    const coverage = computeCoverage(routes, buildTargetSet([]));
    expect(coverage.probeEligible).toBe(0);
    expect(coverage.coveragePct).toBe(100);
    expect(coverage.outcomeDataMissing).toBe(true);
    expect(coverageTone(coverage)).toBe('good');
  });

  it('clears the missing-outcome flag as soon as any route carries a decision', () => {
    const routes = classifyRoutes(
      [route({ pattern: '/dashboard', withoutSession: 5, withoutSessionBlocked: 5, withoutSessionPassed: 0 })],
      { now: NOW },
    );
    const coverage = computeCoverage(routes, buildTargetSet([]));
    expect(coverage.outcomeDataMissing).toBe(false);
    expect(coverage.enforced).toBe(1);
  });

  it('grades the coverage number', () => {
    const base = computeCoverage(classifyRoutes([route({ withSession: 40, withoutSession: 0 })], { now: NOW }), buildTargetSet([]));
    expect(coverageTone({ ...base, probeEligible: 10, coveragePct: 95 })).toBe('good');
    expect(coverageTone({ ...base, probeEligible: 10, coveragePct: 60 })).toBe('warn');
    expect(coverageTone({ ...base, probeEligible: 10, coveragePct: 10 })).toBe('bad');
  });

  it('tracks the most recent sighting across the inventory', () => {
    const routes = classifyRoutes(
      [route({ pattern: '/a', lastSeenAt: daysAgo(5) }), route({ pattern: '/b', lastSeenAt: daysAgo(1) })],
      { now: NOW },
    );
    const coverage = computeCoverage(routes, buildTargetSet([]));
    expect(coverage.lastSeenAt?.toISOString()).toBe(daysAgo(1).toISOString());
  });
});

describe('guard view — filtering, sorting, formatting', () => {
  const routes: ClassifiedRoute[] = [
    classify({ pattern: '/pricing', withSession: 2, withoutSession: 98 }),
    classify({
      pattern: '/admin/users',
      withSession: 30,
      withoutSession: 10,
      withoutSessionBlocked: 5,
      withoutSessionPassed: 5,
    }),
    classify({ pattern: '/dashboard', withSession: 50, withoutSession: 0 }),
    classify({ pattern: '/api/save', method: 'POST', withSession: 20, withoutSession: 0 }),
    classify({ pattern: '/demo', source: 'sample', withSession: 40, withoutSession: 0 }),
  ];

  it('flags the routes that deserve a second look, and never a sample row', () => {
    expect(needsAttention(routes[1]!)).toBe(true); // inconsistent guard
    expect(needsAttention(routes[3]!)).toBe(true); // logged-in POST nothing can test
    expect(needsAttention(routes[0]!)).toBe(false); // public
    expect(needsAttention(routes[2]!)).toBe(false); // logged-in, no problem observed
    expect(needsAttention(routes[4]!)).toBe(false); // sample
  });

  it('filters by category', () => {
    expect(routes.filter((r) => matchesFilter(r, 'all'))).toHaveLength(5);
    // /admin/users is 25% anonymous, so it reads as mixed rather than logged-in-only —
    // which is exactly why enforcement is tracked separately from the traffic mix.
    expect(routes.filter((r) => matchesFilter(r, 'needs_session')).map((r) => r.pattern)).toEqual([
      '/dashboard',
      '/api/save',
      '/demo',
    ]);
    expect(routes.filter((r) => matchesFilter(r, 'public')).map((r) => r.pattern)).toEqual(['/pricing']);
    expect(routes.filter((r) => matchesFilter(r, 'sample')).map((r) => r.pattern)).toEqual(['/demo']);
    expect(routes.filter((r) => matchesFilter(r, 'attention')).map((r) => r.pattern)).toEqual(['/admin/users', '/api/save']);
  });

  it('searches path and method, case-insensitively', () => {
    expect(matchesSearch(routes[1]!, 'ADMIN')).toBe(true);
    expect(matchesSearch(routes[3]!, 'post')).toBe(true);
    expect(matchesSearch(routes[0]!, 'admin')).toBe(false);
    expect(matchesSearch(routes[0]!, '   ')).toBe(true);
  });

  it('sorts worst-first by default', () => {
    const sorted = sortRoutes(routes, 'risk').map((r) => r.pattern);
    expect(sorted[0]).toBe('/admin/users'); // inconsistent enforcement
    expect(sorted[1]).toBe('/api/save'); // unverifiable mutation
    expect(sorted.at(-1)).toBe('/demo'); // sample rows sink to the bottom
  });

  it('sorts by path, traffic and last seen on request', () => {
    expect(sortRoutes(routes, 'pattern').map((r) => r.pattern)).toEqual([
      '/admin/users',
      '/api/save',
      '/dashboard',
      '/demo',
      '/pricing',
    ]);
    expect(sortRoutes(routes, 'traffic')[0]?.pattern).toBe('/pricing'); // 100 requests
    expect(sortRoutes(routes, 'last_seen')).toHaveLength(5);
  });

  it('combines filter, search and sort', () => {
    const out = filterAndSortRoutes(routes, { filter: 'needs_session', search: 'a', sort: 'pattern' });
    expect(out.map((r) => r.pattern)).toEqual(['/api/save', '/dashboard']);
  });

  it('formats the session share and relative times', () => {
    expect(sessionPct(routes[2]!)).toBe(100);
    expect(sessionPct(routes[0]!)).toBe(2);
    expect(formatRelativeTime(new Date(NOW.getTime() - 30_000), NOW)).toBe('just now');
    expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('5m ago');
    expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 3600_000), NOW)).toBe('5h ago');
    expect(formatRelativeTime(daysAgo(3), NOW)).toBe('3d ago');
    expect(formatRelativeTime(null, NOW)).toBe('—');
    expect(formatRelativeTime('nonsense', NOW)).toBe('—');
  });

  it('badges a route first seen inside the last week as new', () => {
    expect(isNewRoute(classify({ firstSeenAt: daysAgo(2) }), NOW)).toBe(true);
    expect(isNewRoute(classify({ firstSeenAt: daysAgo(30) }), NOW)).toBe(false);
  });
});

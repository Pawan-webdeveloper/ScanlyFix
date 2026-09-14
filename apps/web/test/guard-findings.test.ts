import { describe, expect, it } from 'vitest';

import { classifyRoute } from '../lib/runtime/guard/classify.ts';
import { buildTargetSet, type ClassifiedRoute, type GuardRouteInput } from '../lib/runtime/guard/coverage.ts';
import {
  collectGuardFindings,
  countBySeverity,
  findingsForRoute,
  GUARD_FINDING_LABEL,
  RECON_MIN_ANONYMOUS_REQUESTS,
  type GuardFinding,
  type GuardFindingKind,
} from '../lib/runtime/guard/findings.ts';

const NOW = new Date('2026-09-14T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const NO_TARGETS = buildTargetSet([]);

function classify(overrides: Partial<GuardRouteInput> = {}): ClassifiedRoute {
  const base: GuardRouteInput = {
    id: 'r1',
    pattern: '/dashboard',
    method: 'GET',
    kind: 'route',
    source: null,
    withSession: 50,
    withoutSession: 0,
    withoutSessionBlocked: 0,
    withoutSessionPassed: 0,
    firstSeenAt: daysAgo(30),
    lastSeenAt: daysAgo(1),
    ...overrides,
  };
  return { ...base, verdict: classifyRoute(base, { now: NOW }) };
}

const kinds = (findings: GuardFinding[]): GuardFindingKind[] => findings.map((f) => f.kind).sort();

describe('guard findings — what the middleware waved through', () => {
  it('reports an admin route whose logged-out requests all passed through', () => {
    const findings = findingsForRoute(
      classify({
        pattern: '/admin/users',
        withSession: 40,
        withoutSession: 6,
        withoutSessionBlocked: 0,
        withoutSessionPassed: 6,
      }),
      buildTargetSet(['/admin/users']),
    );

    const unenforced = findings.find((f) => f.kind === 'unenforced');
    expect(unenforced).toBeDefined();
    expect(unenforced?.severity).toBe('high');
    expect(unenforced?.title).toContain('not enforced in middleware');
    expect(unenforced?.fixPrompt).toContain('/admin/users');
    expect(unenforced?.fixPrompt).toContain('6 logged-out request');
    expect(unenforced?.evidence['logged-out passed through']).toBe(6);
  });

  it('phrases a pass-through as "not enforced at the edge", never as "this endpoint is open"', () => {
    const finding = findingsForRoute(
      classify({ pattern: '/api/orders', withSession: 40, withoutSession: 4, withoutSessionPassed: 4 }),
      NO_TARGETS,
    ).find((f) => f.kind === 'unenforced');

    // Auth in the route handler is a normal design; the prober is what settles it.
    // Any claim that the route is open must stay conditional on that.
    expect(finding?.impact).toContain('If the handler does not check the session itself');
    expect(finding?.impact).not.toMatch(/\b(confirmed|vulnerable|exploitable|is publicly accessible)\b/i);
    expect(finding?.title).toContain('not enforced in middleware');
  });

  it('drops the severity for an ordinary logged-in page', () => {
    const finding = findingsForRoute(
      classify({ pattern: '/dashboard', withSession: 40, withoutSession: 4, withoutSessionPassed: 4 }),
      NO_TARGETS,
    ).find((f) => f.kind === 'unenforced');
    expect(finding?.severity).toBe('medium');
  });

  it('says nothing when the middleware turned every logged-out request away', () => {
    const findings = findingsForRoute(
      classify({
        pattern: '/admin/users',
        withSession: 40,
        withoutSession: 6,
        withoutSessionBlocked: 6,
        withoutSessionPassed: 0,
      }),
      buildTargetSet(['/admin/users']),
    );
    expect(kinds(findings)).not.toContain('unenforced');
  });

  it('says nothing about a genuinely public route that lets anonymous visitors in', () => {
    const findings = findingsForRoute(
      classify({ pattern: '/pricing', withSession: 2, withoutSession: 98, withoutSessionPassed: 98 }),
      NO_TARGETS,
    );
    expect(findings).toEqual([]);
  });
});

describe('guard findings — inconsistent enforcement', () => {
  it('reports a route that blocked some logged-out requests and passed others', () => {
    const finding = findingsForRoute(
      classify({
        pattern: '/admin/reports',
        withSession: 30,
        withoutSession: 9,
        withoutSessionBlocked: 5,
        withoutSessionPassed: 4,
      }),
      buildTargetSet(['/admin/reports']),
    ).find((f) => f.kind === 'inconsistent_enforcement');

    expect(finding?.severity).toBe('high');
    expect(finding?.impact).toContain('turned away 5');
    expect(finding?.impact).toContain('let 4 through');
    expect(finding?.steps[0]).toMatch(/matcher/i);
    expect(finding?.fixPrompt).toContain('guarded inconsistently');
  });

  it('does not fire on a single pass-through, which is the shape of a deploy window', () => {
    const findings = findingsForRoute(
      classify({
        pattern: '/admin/reports',
        withSession: 30,
        withoutSession: 21,
        withoutSessionBlocked: 20,
        withoutSessionPassed: 1,
      }),
      buildTargetSet(['/admin/reports']),
    );
    expect(kinds(findings)).not.toContain('inconsistent_enforcement');
    expect(kinds(findings)).not.toContain('unenforced');
  });
});

describe('guard findings — coverage and verifiability', () => {
  it('reports a logged-in GET route the prober is not watching', () => {
    const finding = findingsForRoute(classify({ pattern: '/admin/exports' }), NO_TARGETS).find(
      (f) => f.kind === 'coverage_gap',
    );
    expect(finding?.severity).toBe('medium');
    expect(finding?.title).toContain('not checked by the nightly prober');
  });

  it('stays quiet once the route is a prober target', () => {
    const findings = findingsForRoute(classify({ pattern: '/admin/exports' }), buildTargetSet(['/admin/exports']));
    expect(kinds(findings)).not.toContain('coverage_gap');
  });

  it('matches the target through path normalisation, so casing and a trailing slash do not create a false gap', () => {
    const findings = findingsForRoute(classify({ pattern: '/admin/exports' }), buildTargetSet(['/Admin/Exports/']));
    expect(kinds(findings)).not.toContain('coverage_gap');
  });

  it('reports a logged-in POST route as needing a manual check, not as a coverage gap', () => {
    const findings = findingsForRoute(classify({ pattern: '/api/invoices', method: 'POST' }), NO_TARGETS);
    expect(kinds(findings)).toContain('unverifiable');
    expect(kinds(findings)).not.toContain('coverage_gap');

    const finding = findings.find((f) => f.kind === 'unverifiable');
    expect(finding?.title).toContain('cannot be verified automatically');
    expect(finding?.impact).toContain('would change your data');
  });

  it('warns specifically about server actions being reachable by action id', () => {
    const finding = findingsForRoute(
      classify({ pattern: '/api/delete-account', method: 'POST', kind: 'server_action' }),
      NO_TARGETS,
    ).find((f) => f.kind === 'unverifiable');

    expect(finding?.title).toContain('Server action');
    expect(finding?.steps[0]).toContain('reachable by anyone who knows the action id');
  });

  it('reports a logged-in route nothing has seen for weeks, and does not also call it a coverage gap', () => {
    const findings = findingsForRoute(classify({ pattern: '/admin/legacy', lastSeenAt: daysAgo(40) }), NO_TARGETS);
    expect(kinds(findings)).toContain('stale_route');
    // A dead route is not worth adding to the nightly run.
    expect(kinds(findings)).not.toContain('coverage_gap');
    expect(findings.find((f) => f.kind === 'stale_route')?.title).toContain('40 days');
  });
});

describe('guard findings — anonymous traffic on a real admin surface', () => {
  it('reports sustained anonymous traffic on an admin panel that is otherwise guarded', () => {
    const finding = findingsForRoute(
      classify({
        pattern: '/admin',
        withSession: 40,
        withoutSession: 60,
        withoutSessionBlocked: 60,
        withoutSessionPassed: 0,
      }),
      buildTargetSet(['/admin']),
    ).find((f) => f.kind === 'recon_traffic');

    expect(finding?.severity).toBe('low');
    expect(finding?.impact).toContain('60 logged-out requests');
  });

  it('stays quiet below the sustained-traffic threshold', () => {
    const findings = findingsForRoute(
      classify({
        pattern: '/admin',
        withSession: 40,
        withoutSession: RECON_MIN_ANONYMOUS_REQUESTS - 1,
        withoutSessionBlocked: RECON_MIN_ANONYMOUS_REQUESTS - 1,
      }),
      buildTargetSet(['/admin']),
    );
    expect(kinds(findings)).not.toContain('recon_traffic');
  });

  it('stays quiet on a path with no signed-in traffic — that is a bot hitting a route the app does not have', () => {
    const findings = findingsForRoute(
      classify({ pattern: '/admin', withSession: 0, withoutSession: 400, withoutSessionBlocked: 400 }),
      NO_TARGETS,
    );
    expect(kinds(findings)).not.toContain('recon_traffic');
  });

  it('does not pile a recon finding on top of an unenforced one', () => {
    // 43% anonymous → mixed, so it is still a logged-in surface; at 60% it would read as public.
    const findings = findingsForRoute(
      classify({ pattern: '/admin', withSession: 40, withoutSession: 30, withoutSessionPassed: 30 }),
      buildTargetSet(['/admin']),
    );
    expect(kinds(findings)).toContain('unenforced');
    expect(kinds(findings)).not.toContain('recon_traffic');
  });
});

describe('guard findings — honesty rules', () => {
  it('never reports anything for sample rows', () => {
    const findings = findingsForRoute(
      classify({
        pattern: '/admin/users',
        source: 'sample',
        withSession: 40,
        withoutSession: 20,
        withoutSessionPassed: 20,
      }),
      NO_TARGETS,
    );
    expect(findings).toEqual([]);
  });

  it('never reports anything below three observations', () => {
    const findings = findingsForRoute(
      classify({ pattern: '/admin/new', withSession: 1, withoutSession: 1, withoutSessionPassed: 1 }),
      NO_TARGETS,
    );
    expect(findings).toEqual([]);
  });

  it('carries a copy-paste fix prompt on every finding that names a code change', () => {
    const findings = findingsForRoute(
      classify({ pattern: '/api/admin', withSession: 40, withoutSession: 6, withoutSessionPassed: 6 }),
      NO_TARGETS,
    );
    for (const f of findings.filter((x) => x.kind === 'unenforced' || x.kind === 'unverifiable')) {
      expect(f.fixPrompt.length).toBeGreaterThan(80);
      expect(f.fixPrompt).toContain(f.pattern);
      expect(f.steps.length).toBeGreaterThan(0);
    }
  });

  it('gives every finding kind a label for the UI', () => {
    const allKinds: GuardFindingKind[] = [
      'unenforced',
      'inconsistent_enforcement',
      'coverage_gap',
      'unverifiable',
      'stale_route',
      'recon_traffic',
    ];
    for (const k of allKinds) expect(GUARD_FINDING_LABEL[k].length).toBeGreaterThan(3);
  });
});

describe('guard findings — collection', () => {
  const routes: ClassifiedRoute[] = [
    classify({ id: 'a', pattern: '/pricing', withSession: 2, withoutSession: 98 }),
    classify({ id: 'b', pattern: '/dashboard', withSession: 40, withoutSession: 0 }),
    classify({
      id: 'c',
      pattern: '/admin/users',
      withSession: 40,
      withoutSession: 6,
      withoutSessionBlocked: 0,
      withoutSessionPassed: 6,
    }),
    classify({ id: 'd', pattern: '/api/invoices', method: 'POST', withSession: 20, withoutSession: 0 }),
  ];

  it('sorts worst-first and keeps ids stable and unique', () => {
    const findings = collectGuardFindings(routes, NO_TARGETS);
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.pattern).toBe('/admin/users');
    expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
    // Stable across runs — the UI keys on this.
    expect(collectGuardFindings(routes, NO_TARGETS).map((f) => f.id)).toEqual(findings.map((f) => f.id));
  });

  it('counts by severity', () => {
    const counts = countBySeverity(collectGuardFindings(routes, NO_TARGETS));
    expect(counts.critical).toBe(0);
    expect(counts.high).toBeGreaterThan(0);
    expect(counts.medium).toBeGreaterThan(0);
  });

  it('returns nothing for a clean, fully covered inventory', () => {
    const clean = [
      classify({ pattern: '/dashboard', withSession: 40, withoutSession: 2, withoutSessionBlocked: 2 }),
      classify({ pattern: '/pricing', withSession: 2, withoutSession: 98 }),
    ];
    expect(collectGuardFindings(clean, buildTargetSet(['/dashboard']))).toEqual([]);
  });
});

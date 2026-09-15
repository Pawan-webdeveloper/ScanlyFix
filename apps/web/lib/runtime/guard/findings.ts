/**
 * Turning observations into things a developer can act on.
 *
 * Guard's raw output is a table of counters, and a table of counters is not a
 * security product. Every rule here answers "so what should I change?", and
 * each one is deliberately conservative about what the evidence supports:
 *
 *   - A middleware pass-through is reported as "not enforced at the edge",
 *     never as "this endpoint is open". Auth in the route handler is a normal,
 *     correct design; the prober is what settles whether it is actually there.
 *   - Sample rows never produce findings. They exist to show a new user what
 *     the feature looks like, and a demo that fabricates security findings is
 *     worse than no demo.
 *   - Nothing is reported from fewer than three observations.
 */

import { CATEGORY_LABEL } from '../auth-prober/targets';
import type { TargetCategory } from '../auth-prober/types';
import type { ClassifiedRoute } from './coverage';
import { isProbed } from './coverage';

export type GuardSeverity = 'critical' | 'high' | 'medium' | 'low';

export const GUARD_SEVERITY_ORDER: ReadonlyArray<GuardSeverity> = ['critical', 'high', 'medium', 'low'];

export type GuardFindingKind =
  /** Logged-out requests were waved through the middleware on a logged-in surface. */
  | 'unenforced'
  /** The same route blocked some logged-out requests and passed others. */
  | 'inconsistent_enforcement'
  /** A logged-in surface the nightly prober is not watching. */
  | 'coverage_gap'
  /** A logged-in surface the prober cannot express — POST route or server action. */
  | 'unverifiable'
  /** A prober target whose route has not been seen in weeks. */
  | 'stale_route'
  /** A real admin/debug surface under sustained anonymous traffic. */
  | 'recon_traffic';

export type GuardFinding = {
  /** Stable across runs, so the UI can key on it and dedupe. */
  id: string;
  kind: GuardFindingKind;
  severity: GuardSeverity;
  pattern: string;
  method: string;
  kindOfRoute: string;
  category: TargetCategory;
  title: string;
  impact: string;
  steps: string[];
  /** Copy-paste prompt for Claude / Cursor / Windsurf. */
  fixPrompt: string;
  evidence: Record<string, string | number>;
};

/** Sustained anonymous traffic to a real admin surface, below which it is just background noise. */
export const RECON_MIN_ANONYMOUS_REQUESTS = 20;

const SENSITIVE: ReadonlySet<TargetCategory> = new Set<TargetCategory>(['admin', 'api', 'debug']);

function findingId(kind: GuardFindingKind, method: string, pattern: string): string {
  return `${kind}:${method.toUpperCase()} ${pattern}`;
}

function routeLabel(category: TargetCategory, pattern: string): string {
  return `${CATEGORY_LABEL[category]} ${pattern}`;
}

function trafficEvidence(route: ClassifiedRoute): Record<string, string | number> {
  const blocked = route.withoutSessionBlocked ?? 0;
  const passed = route.withoutSessionPassed ?? 0;
  const evidence: Record<string, string | number> = {
    'requests with session': route.withSession,
    'requests without session': route.withoutSession,
  };
  if (blocked + passed > 0) {
    evidence['logged-out blocked by middleware'] = blocked;
    evidence['logged-out passed through'] = passed;
  }
  if (route.verdict.ageDays !== null) evidence['last seen'] = `${route.verdict.ageDays}d ago`;
  return evidence;
}

function guardSteps(category: TargetCategory, method: string): string[] {
  if (category === 'api' || method !== 'GET') {
    return [
      'Check the session at the top of the handler and return 401 before reading or writing anything.',
      'Add the route to your middleware matcher so the check cannot be dropped in a refactor.',
      'If the data lives in Supabase or PostgREST, enable RLS on the tables it touches and scope the policies to auth.uid().',
    ];
  }
  if (category === 'admin') {
    return [
      'Require an authenticated session with an admin role in middleware for the whole prefix, not per page.',
      'Redirect logged-out visitors to sign-in instead of rendering the panel.',
      'Review what was reachable while the guard was missing — user changes, exports, settings.',
    ];
  }
  if (category === 'debug') {
    return [
      'Gate the endpoint on NODE_ENV or a flag that is off in production, or delete it.',
      'If it must stay, put it behind authentication and an IP allow-list.',
      'Check what it disclosed — env vars, stack traces, internal URLs — and rotate anything sensitive.',
    ];
  }
  return [
    'Check the session in middleware or the page loader and redirect logged-out visitors to sign-in.',
    'Do the redirect on the server: a client-side one still ships the rendered HTML to an anonymous visitor.',
  ];
}

function evidenceBlock(evidence: Record<string, string | number>): string {
  return Object.entries(evidence)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
}

/**
 * Every finding for one route. Returns an empty array for sample rows and for
 * routes with too little traffic to judge.
 */
export function findingsForRoute(route: ClassifiedRoute, targets: ReadonlySet<string>): GuardFinding[] {
  if (route.source === 'sample') return [];

  const { verdict } = route;
  const { category } = verdict;
  const method = route.method.toUpperCase();
  const isSensitive = SENSITIVE.has(category);
  const isLoggedInSurface = verdict.sessionProfile === 'session_only' || verdict.sessionProfile === 'mixed';
  const evidence = trafficEvidence(route);
  const findings: GuardFinding[] = [];

  // ── The middleware waved logged-out requests through ──────────────────────
  if (isLoggedInSurface && verdict.enforcement === 'unenforced') {
    const steps = guardSteps(category, method);
    findings.push({
      id: findingId('unenforced', method, route.pattern),
      kind: 'unenforced',
      severity: isSensitive ? 'high' : 'medium',
      pattern: route.pattern,
      method,
      kindOfRoute: route.kind,
      category,
      title: `${routeLabel(category, route.pattern)} is not enforced in middleware`,
      impact:
        `${route.withoutSession} logged-out request(s) reached this route and your middleware let every one of them through, ` +
        'even though real users only reach it while signed in. If the handler does not check the session itself, the route is open.',
      steps,
      fixPrompt: [
        `Security review: ${method} ${route.pattern} is a logged-in-only surface in our app, but our Next.js middleware passed ${route.withoutSessionPassed ?? route.withoutSession} logged-out request(s) straight through without a 401, 403 or a redirect to sign-in.`,
        `Observed traffic:\n${evidenceBlock(evidence)}`,
        `Show me where authentication is enforced for this route. If it is only enforced in the client or not at all, fix it: ${steps.join(' ')} Give me the diff.`,
      ].join('\n\n'),
      evidence,
    });
  }

  // ── Same route, two different answers ─────────────────────────────────────
  if (isLoggedInSurface && verdict.enforcement === 'inconsistent') {
    const steps = [
      'Compare the middleware matcher against this exact path — a missing segment or a negative lookahead usually explains the gap.',
      'Check for early returns in the middleware (locale handling, static-file shortcuts) that skip the auth branch.',
      ...guardSteps(category, method),
    ];
    findings.push({
      id: findingId('inconsistent_enforcement', method, route.pattern),
      kind: 'inconsistent_enforcement',
      severity: isSensitive ? 'high' : 'medium',
      pattern: route.pattern,
      method,
      kindOfRoute: route.kind,
      category,
      title: `${routeLabel(category, route.pattern)} is guarded inconsistently`,
      impact:
        `Your middleware turned away ${route.withoutSessionBlocked ?? 0} logged-out request(s) to this route and let ` +
        `${route.withoutSessionPassed ?? 0} through. Same route, same conditions, two different answers — some path to it skips the guard.`,
      steps,
      fixPrompt: [
        `Security review: ${method} ${route.pattern} is guarded inconsistently. Our Next.js middleware blocked ${route.withoutSessionBlocked ?? 0} logged-out request(s) to it but let ${route.withoutSessionPassed ?? 0} through.`,
        `Observed traffic:\n${evidenceBlock(evidence)}`,
        'Find why some requests to this route skip the auth branch — check the middleware matcher, early returns, and any route group or rewrite that bypasses it. Show me the matcher and the fix.',
      ].join('\n\n'),
      evidence,
    });
  }

  // ── Nothing is verifying this logged-in surface ───────────────────────────
  if (verdict.needsSession && verdict.probeable && !verdict.stale && !isProbed(route, targets)) {
    findings.push({
      id: findingId('coverage_gap', method, route.pattern),
      kind: 'coverage_gap',
      severity: isSensitive ? 'medium' : 'low',
      pattern: route.pattern,
      method,
      kindOfRoute: route.kind,
      category,
      title: `${routeLabel(category, route.pattern)} is not checked by the nightly prober`,
      impact:
        'Your users reach this route only while signed in, but nothing verifies that it still refuses anonymous visitors. ' +
        'A deploy that drops the auth check here would go unnoticed.',
      steps: [
        'Click "Sync to prober" to add this route to the nightly logged-out check.',
        'The first run records a baseline; later runs alert you if the response ever changes to an open one.',
      ],
      fixPrompt: '',
      evidence,
    });
  }

  // ── The prober cannot express this route ─────────────────────────────────
  if (verdict.needsSession && !verdict.probeable) {
    const isAction = route.kind === 'server_action';
    const steps = [
      isAction
        ? 'Server actions are POST endpoints reachable by anyone who knows the action id — check the session inside the action body, not only in the page that renders the form.'
        : 'Check the session at the top of the handler before this method reads or writes anything.',
      'Add an integration test that calls it with no cookies and asserts a 401 — the nightly prober cannot do this one for you.',
    ];
    findings.push({
      id: findingId('unverifiable', method, route.pattern),
      kind: 'unverifiable',
      severity: 'medium',
      pattern: route.pattern,
      method,
      kindOfRoute: route.kind,
      category,
      title: `${isAction ? 'Server action' : `${method} endpoint`} ${route.pattern} cannot be verified automatically`,
      impact:
        'The nightly prober only sends logged-out GET requests, because sending anything else to your production app would ' +
        'change your data. This surface needs a session and has to be checked by hand or in your test suite.',
      steps,
      fixPrompt: [
        `Security review: ${isAction ? 'the server action' : `the ${method} endpoint`} ${route.pattern} is only used by signed-in users in our app, and our automated prober cannot test it because it never sends non-GET requests to production.`,
        `Observed traffic:\n${evidenceBlock(evidence)}`,
        `Show me where the session is verified for this ${isAction ? 'action' : 'handler'}. If it is missing, add it and write a test that calls it with no cookies and expects 401. ${steps.join(' ')}`,
      ].join('\n\n'),
      evidence,
    });
  }

  // ── The inventory has drifted from the deployed app ──────────────────────
  if (verdict.needsSession && verdict.stale) {
    findings.push({
      id: findingId('stale_route', method, route.pattern),
      kind: 'stale_route',
      severity: 'low',
      pattern: route.pattern,
      method,
      kindOfRoute: route.kind,
      category,
      title: `${route.pattern} has not been seen for ${verdict.ageDays} days`,
      impact:
        'No traffic has reached this route in weeks. Either it was removed and its prober target is now checking a path ' +
        'that no longer exists, or it is a rarely used admin surface that nobody is watching.',
      steps: [
        'If the route was removed, delete its prober target so the nightly run stops testing a dead path.',
        'If it still exists, confirm it is still guarded — routes nobody visits are the ones that quietly lose their auth check.',
      ],
      fixPrompt: '',
      evidence,
    });
  }

  // ── Somebody is knocking ─────────────────────────────────────────────────
  if (
    (category === 'admin' || category === 'debug') &&
    route.withSession > 0 &&
    route.withoutSession >= RECON_MIN_ANONYMOUS_REQUESTS &&
    verdict.enforcement !== 'unenforced'
  ) {
    findings.push({
      id: findingId('recon_traffic', method, route.pattern),
      kind: 'recon_traffic',
      severity: 'low',
      pattern: route.pattern,
      method,
      kindOfRoute: route.kind,
      category,
      title: `${routeLabel(category, route.pattern)} is under sustained anonymous traffic`,
      impact:
        `${route.withoutSession} logged-out requests reached this ${CATEGORY_LABEL[category].toLowerCase()}. ` +
        'It is a real surface in your app, so this is somebody looking for a way in rather than ordinary browsing.',
      steps: [
        'Confirm the guard on this prefix is server-side and returns the same response whether or not the account exists.',
        'Add rate limiting on the prefix so enumeration is slow and visible.',
        'If this panel does not need to be on the public internet, put it behind an IP allow-list or a VPN.',
      ],
      fixPrompt: '',
      evidence,
    });
  }

  return findings;
}

export function collectGuardFindings(
  routes: ReadonlyArray<ClassifiedRoute>,
  targets: ReadonlySet<string>,
): GuardFinding[] {
  const all = routes.flatMap((route) => findingsForRoute(route, targets));
  return all.sort((a, b) => {
    const bySeverity = GUARD_SEVERITY_ORDER.indexOf(a.severity) - GUARD_SEVERITY_ORDER.indexOf(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.pattern.localeCompare(b.pattern);
  });
}

export function countBySeverity(findings: ReadonlyArray<GuardFinding>): Record<GuardSeverity, number> {
  const counts: Record<GuardSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export const GUARD_FINDING_LABEL: Readonly<Record<GuardFindingKind, string>> = {
  unenforced: 'Not enforced in middleware',
  inconsistent_enforcement: 'Inconsistent guard',
  coverage_gap: 'Not probed',
  unverifiable: 'Needs manual check',
  stale_route: 'Stale route',
  recon_traffic: 'Anonymous traffic',
};

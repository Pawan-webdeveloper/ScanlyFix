/**
 * End-to-end: a real Next-style auth middleware wrapped by the real `withGuard`,
 * real traffic driven through it, the real runtime client flushing over real
 * HTTP to a real server, the real aggregation, and the real classification and
 * findings on the other side.
 *
 * Only the database is replaced — by an array. Everything between the request
 * and the dashboard verdict is the shipped code.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';

import {
  aggregateRouteEvents,
  type IngestRouteEvent,
  type RouteEventTotals,
} from '../../../packages/db/src/queries/route-aggregation.ts';
import { withGuard, type NextRequestLike } from '../../../packages/runtime-sdk/src/guard/middleware.ts';
import { createRuntime, type RuntimeClient } from '../../../packages/runtime-sdk/src/runtime.ts';
import {
  buildTargetSet,
  classifyRoutes,
  computeCoverage,
  type GuardRouteInput,
} from '../lib/runtime/guard/coverage.ts';
import { collectGuardFindings } from '../lib/runtime/guard/findings.ts';

// ── The ScanlyFix ingest endpoint, for real, over a socket ──────────────────
const SIGNING_SECRET = 'test-signing-secret';
const received: { events: IngestRouteEvent[]; signatures: string[]; projectIds: string[] } = {
  events: [],
  signatures: [],
  projectIds: [],
};

/** Mirrors the validation the production route applies before recording anything. */
const ROUTE_PATTERN_REGEX = /^\/[a-zA-Z0-9_\-./:[\]*~]{0,255}$/;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const ALLOWED_OUTCOMES = new Set(['blocked', 'passed', 'unknown']);

function handleIngest(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      received.signatures.push(String(req.headers['x-runtime-signature'] ?? ''));
      received.projectIds.push(String(req.headers['x-runtime-project-id'] ?? ''));

      const parsed = JSON.parse(body) as { events?: Array<Record<string, unknown>> };
      for (const ev of parsed.events ?? []) {
        const pattern = String(ev.pattern ?? '');
        const method = String(ev.method ?? '').toUpperCase();
        if (!ROUTE_PATTERN_REGEX.test(pattern) || !ALLOWED_METHODS.has(method)) continue;
        const outcome = String(ev.outcome ?? 'unknown');
        received.events.push({
          pattern,
          method,
          kind: typeof ev.kind === 'string' ? ev.kind : undefined,
          hasSession: Boolean(ev.hasSession),
          outcome: (ALLOWED_OUTCOMES.has(outcome) ? outcome : 'unknown') as IngestRouteEvent['outcome'],
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
}

let server: Server;
let runtime: RuntimeClient;

beforeAll(async () => {
  server = createServer(handleIngest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  runtime = createRuntime({
    projectId: '11111111-1111-4111-8111-111111111111',
    ingestUrl: `http://127.0.0.1:${addr.port}/api/runtime/ingest`,
    signingSecret: SIGNING_SECRET,
    maxBatchSize: 50,
    flushIntervalMs: 50,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── The customer's own middleware, bug included ─────────────────────────────

/** Paths this app's middleware guards. /api/internal/export is missing — that is the point. */
const GUARDED_PREFIXES = ['/admin', '/dashboard', '/settings', '/api/projects'];

/**
 * A realistic Next middleware: redirects anonymous visitors on guarded prefixes
 * to the sign-in page. `/admin/reports` is reached through a legacy route group
 * that skips the guard on some requests — the kind of matcher gap Guard exists
 * to find.
 */
function makeAuthMiddleware() {
  let legacyToggle = 0;
  return async function auth(req: NextRequestLike): Promise<Response> {
    const { pathname } = req.nextUrl;
    const hasSession = (req.headers.get('cookie') ?? '').includes('sb-demo-auth-token=');

    if (pathname === '/admin/reports') {
      // Every other request arrives through the legacy group, which never runs the check.
      legacyToggle += 1;
      if (legacyToggle % 2 === 0) return NextResponse.next() as unknown as Response;
    }

    const isGuarded = GUARDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    if (isGuarded && !hasSession) {
      return NextResponse.redirect(`https://app.test/login?next=${encodeURIComponent(pathname)}`) as unknown as Response;
    }
    return NextResponse.next() as unknown as Response;
  };
}

function makeRequest(pathname: string, options: { method?: string; signedIn?: boolean; isServerAction?: boolean } = {}): NextRequestLike {
  const headers = new Map<string, string>();
  if (options.signedIn) headers.set('cookie', 'sb-demo-auth-token=abc123');
  if (options.isServerAction) headers.set('next-action', 'a1b2c3');
  headers.set('host', 'app.test');
  return {
    nextUrl: { pathname, hostname: 'app.test' },
    method: options.method ?? 'GET',
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => headers.has(name.toLowerCase()),
    },
  };
}

/** Turns the events the ingest server actually received into dashboard rows. */
function buildRoutes(totals: Map<string, RouteEventTotals>): GuardRouteInput[] {
  const now = new Date();
  return Array.from(totals.values()).map((t) => ({
    id: `${t.method} ${t.pattern}`,
    pattern: t.pattern,
    method: t.method,
    kind: t.kind,
    source: null,
    withSession: t.withSession,
    withoutSession: t.withoutSession,
    withoutSessionBlocked: t.withoutSessionBlocked,
    withoutSessionPassed: t.withoutSessionPassed,
    firstSeenAt: now,
    lastSeenAt: now,
  }));
}

describe('guard — live end-to-end through the real middleware and the wire', () => {
  beforeEach(() => {
    received.events = [];
    received.signatures = [];
    received.projectIds = [];
  });

  it('carries real traffic from middleware to dashboard verdict', async () => {
    const middleware = withGuard(makeAuthMiddleware(), { runtime });

    // ── Drive a week of plausible traffic ───────────────────────────────────
    const plan: Array<[string, { method?: string; signedIn?: boolean; isServerAction?: boolean }, number]> = [
      // Properly guarded logged-in surfaces.
      ['/dashboard', { signedIn: true }, 20],
      ['/dashboard', {}, 6], // anonymous → redirected to sign-in
      ['/settings/billing', { signedIn: true }, 10],
      ['/settings/billing', {}, 3],
      // Guarded, and also already a prober target.
      ['/api/projects', { signedIn: true }, 15],
      ['/api/projects', {}, 4],
      // THE BUG: never added to the middleware's guarded list.
      ['/api/internal/export', { signedIn: true }, 12],
      ['/api/internal/export', {}, 5],
      // THE OTHER BUG: a legacy route group that skips the guard every other request.
      ['/admin/reports', { signedIn: true }, 14],
      ['/admin/reports', {}, 8],
      // A mutation nothing can probe.
      ['/api/invoices', { method: 'POST', signedIn: true, isServerAction: true }, 9],
      // Genuinely public pages.
      ['/pricing', {}, 40],
      ['/pricing', { signedIn: true }, 3],
    ];

    for (const [path, options, count] of plan) {
      for (let i = 0; i < count; i++) {
        const res = await middleware(makeRequest(path, options));
        expect(res).toBeDefined();
      }
    }

    // The SDK batches; make sure everything queued has actually crossed the wire.
    await runtime.flush('app.test');
    await new Promise((r) => setTimeout(r, 150));
    await runtime.flush('app.test');

    // ── The transport worked ────────────────────────────────────────────────
    expect(received.events.length).toBe(149);
    expect(received.signatures.every((s) => s === SIGNING_SECRET)).toBe(true);
    expect(received.projectIds.every((id) => id === '11111111-1111-4111-8111-111111111111')).toBe(true);
    // The homepage and static assets were never reported.
    expect(received.events.some((e) => e.pattern === '/')).toBe(false);

    // ── The aggregation and classification agree with what the app did ──────
    const totals = aggregateRouteEvents(received.events);
    const routes = classifyRoutes(buildRoutes(totals));
    const byPattern = new Map(routes.map((r) => [`${r.method} ${r.pattern}`, r]));

    const dashboard = byPattern.get('GET /dashboard')!;
    // 6 anonymous requests arrived and all 6 were redirected to /login, so none
    // was served — the route reads as a logged-in surface, not as mixed traffic.
    expect(dashboard.verdict.enforcement).toBe('enforced');
    expect(dashboard.verdict.sessionProfile).toBe('session_only');
    expect(dashboard.withoutSessionBlocked).toBe(6);
    expect(dashboard.withoutSessionPassed).toBe(0);

    const leaky = byPattern.get('GET /api/internal/export')!;
    expect(leaky.verdict.enforcement).toBe('unenforced'); // the middleware never guarded it
    expect(leaky.withoutSessionPassed).toBe(5);
    // Those 5 really were served, so they count against the traffic mix.
    expect(leaky.verdict.sessionProfile).toBe('mixed');

    const inconsistent = byPattern.get('GET /admin/reports')!;
    expect(inconsistent.verdict.enforcement).toBe('inconsistent'); // the legacy group skips the guard
    expect(inconsistent.withoutSessionBlocked).toBeGreaterThan(0);
    expect(inconsistent.withoutSessionPassed).toBeGreaterThan(0);

    const action = byPattern.get('POST /api/invoices')!;
    expect(action.kind).toBe('server_action');
    expect(action.verdict.needsSession).toBe(true);
    expect(action.verdict.probeable).toBe(false);

    const pricing = byPattern.get('GET /pricing')!;
    expect(pricing.verdict.sessionProfile).toBe('public');

    // ── Coverage and findings ───────────────────────────────────────────────
    const targets = buildTargetSet(['/api/projects']);
    const coverage = computeCoverage(routes, targets);
    expect(coverage.unenforced).toBe(1); // /api/internal/export
    expect(coverage.inconsistent).toBe(1); // /admin/reports
    expect(coverage.enforced).toBe(3); // /dashboard, /settings/billing, /api/projects
    expect(coverage.unverifiable).toBe(1); // the server action
    // /pricing is served anonymously by design and is not counted as unenforced.
    expect(coverage.publicRoutes).toBe(1);
    expect(coverage.probeEligible).toBe(3);
    expect(coverage.probed).toBe(1);
    expect(coverage.coveragePct).toBe(33);
    expect(coverage.outcomeDataMissing).toBe(false);

    const findings = collectGuardFindings(routes, targets);
    const byKind = new Map(findings.map((f) => [`${f.kind}:${f.pattern}`, f]));

    // The two real bugs are reported, worst first.
    expect(findings[0]?.severity).toBe('high');
    expect(byKind.has('unenforced:/api/internal/export')).toBe(true);
    expect(byKind.has('inconsistent_enforcement:/admin/reports')).toBe(true);
    // The server action is flagged as needing a human.
    expect(byKind.has('unverifiable:/api/invoices')).toBe(true);
    // The correctly guarded routes are not.
    expect(byKind.has('unenforced:/dashboard')).toBe(false);
    expect(byKind.has('unenforced:/pricing')).toBe(false);
    // /api/projects is already probed, so it is not a coverage gap.
    expect(byKind.has('coverage_gap:/api/projects')).toBe(false);
    // The other two guarded surfaces are not probed, so they are.
    expect(byKind.has('coverage_gap:/dashboard')).toBe(true);
    expect(byKind.has('coverage_gap:/settings/billing')).toBe(true);
    // A public page is never a coverage gap.
    expect(byKind.has('coverage_gap:/pricing')).toBe(false);

    // Every reported bug carries a prompt naming the route.
    for (const f of findings.filter((x) => x.fixPrompt.length > 0)) {
      expect(f.fixPrompt).toContain(f.pattern);
    }
  });

  it('stops recording middleware decisions when withGuard is used without a middleware', async () => {
    const middleware = withGuard(undefined, { runtime });

    for (let i = 0; i < 5; i++) await middleware(makeRequest('/dashboard'));
    for (let i = 0; i < 5; i++) await middleware(makeRequest('/dashboard', { signedIn: true }));

    await runtime.flush('app.test');
    await new Promise((r) => setTimeout(r, 150));
    await runtime.flush('app.test');

    const routes = classifyRoutes(buildRoutes(aggregateRouteEvents(received.events)));
    const dashboard = routes.find((r) => r.pattern === '/dashboard')!;

    // The traffic mix is still learned…
    expect(dashboard.verdict.sessionProfile).toBe('mixed');
    // …but nothing is claimed about enforcement, and the dashboard says so.
    expect(dashboard.verdict.enforcement).toBe('unknown');
    expect(computeCoverage(routes, buildTargetSet([])).outcomeDataMissing).toBe(true);
    expect(collectGuardFindings(routes, buildTargetSet([])).some((f) => f.kind === 'unenforced')).toBe(false);
  });

  it('never leaks ids, emails or query strings into a reported pattern', async () => {
    const middleware = withGuard(makeAuthMiddleware(), { runtime });

    await middleware(makeRequest('/api/users/8f14e45f-ceea-467a-9575-9d1b1f0b0d1e', { signedIn: true }));
    await middleware(makeRequest('/api/users/42', { signedIn: true }));
    await middleware(makeRequest('/invite/alice@example.com', { signedIn: true }));
    await middleware(makeRequest('/reset/aVeryLongOpaqueResetTokenValue123', { signedIn: true }));

    await runtime.flush('app.test');
    await new Promise((r) => setTimeout(r, 150));
    await runtime.flush('app.test');

    const patterns = received.events.map((e) => e.pattern);
    expect(patterns).toContain('/api/users/[id]');
    expect(patterns).toContain('/invite/[email]');
    expect(patterns).toContain('/reset/[token]');
    for (const p of patterns) {
      expect(p).not.toContain('@example.com');
      expect(p).not.toContain('8f14e45f');
      expect(p).not.toContain('aVeryLongOpaqueResetToken');
      expect(p).not.toContain('?');
    }
  });
});

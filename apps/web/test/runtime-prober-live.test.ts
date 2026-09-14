/**
 * End-to-end: a REAL local HTTP server standing in for a customer app, the REAL
 * probe/analyse/classify pipeline over the network, and an in-memory stand-in
 * for the DB. Only `@scanlyfix/db` is mocked. This is the "does the feature
 * actually work" test.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── In-memory DB ────────────────────────────────────────────────────────────
type Target = {
  id: string;
  projectId: string;
  path: string;
  method: string;
  source: string;
  baselineStatus: number | null;
  baselineAt: Date | null;
  lastCheckedAt: Date | null;
  lastActualStatus: number | null;
  lastVerdict: string | null;
  lastReason: string | null;
  createdAt: Date;
};
type Finding = {
  id: string;
  projectId: string;
  targetId: string;
  path: string;
  method: string;
  baselineStatus: number;
  actualStatus: number;
  severity: string;
  variant: string | null;
  keyFingerprint: string | null;
  category: string | null;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const db = { targets: [] as Target[], findings: [] as Finding[], hostname: '' };
let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

vi.mock('@scanlyfix/db', () => ({
  getRuntimeProjectContext: async () => ({ id: 'proj_live', hostname: db.hostname, isVerified: true }),
  listProberTargets: async () => [...db.targets].sort((a, b) => a.path.localeCompare(b.path)),
  seedProberTargets: async (projectId: string, specs: Array<{ path: string; method: string; source: string }>) => {
    for (const s of specs) {
      if (db.targets.some((t) => t.path === s.path)) continue;
      db.targets.push({
        id: nextId('t'),
        projectId,
        path: s.path,
        method: 'GET',
        source: s.source,
        baselineStatus: null,
        baselineAt: null,
        lastCheckedAt: null,
        lastActualStatus: null,
        lastVerdict: null,
        lastReason: null,
        createdAt: new Date(),
      });
    }
  },
  setBaseline: async (id: string, status: number, meta: { verdict?: string; reason?: string | null } = {}) => {
    const t = db.targets.find((x) => x.id === id)!;
    Object.assign(t, { baselineStatus: status, baselineAt: new Date(), lastCheckedAt: new Date(), lastActualStatus: status, lastVerdict: meta.verdict ?? 'baseline_recorded', lastReason: meta.reason ?? null });
  },
  recordCheck: async (id: string, status: number, meta: { verdict?: string; reason?: string | null } = {}) => {
    const t = db.targets.find((x) => x.id === id)!;
    Object.assign(t, { lastCheckedAt: new Date(), lastActualStatus: status, lastVerdict: meta.verdict ?? t.lastVerdict, lastReason: meta.reason ?? t.lastReason });
  },
  findUnresolvedFinding: async (_p: string, path: string, method: string, variant: string | null | undefined) =>
    db.findings.find((f) => f.path === path && f.method === method && f.resolvedAt === null && (f.variant ?? null) === (variant ?? null)) ?? null,
  insertFinding: async (input: Omit<Finding, 'id' | 'resolvedAt' | 'createdAt' | 'updatedAt'>) => {
    const row: Finding = { id: nextId('f'), resolvedAt: null, createdAt: new Date(), updatedAt: new Date(), ...input, variant: input.variant ?? null, keyFingerprint: input.keyFingerprint ?? null, category: input.category ?? null, reason: input.reason ?? null, evidence: input.evidence ?? null };
    db.findings.push(row);
    return row;
  },
  touchFinding: async (id: string) => {
    const f = db.findings.find((x) => x.id === id)!;
    f.updatedAt = new Date();
  },
  autoResolveFinding: async (id: string) => {
    const f = db.findings.find((x) => x.id === id)!;
    f.resolvedAt = new Date();
  },
  listFindings: async () => [...db.findings],
  getProjectAnonKey: async () => null,
  updateProjectAnonKey: async () => undefined,
}));

import { runAuthProber } from '../lib/runtime/auth-prober/engine.ts';
import { probeTarget } from '../lib/runtime/auth-prober/probe.ts';
import { buildRemediation } from '../lib/runtime/auth-prober/remediation.ts';
import { summarizeTargets } from '../lib/runtime/auth-prober/summary.ts';

// ── Fake customer app ───────────────────────────────────────────────────────
const SHELL = `<!doctype html><html><head><title>Acme</title></head><body><div id="root"></div><script src="/static/app.js"></script></body></html>`;
const LOGIN = `<!doctype html><html><head><title>Sign in · Acme</title></head><body><form action="/api/auth/login" method="post"><input type="email" name="email"><input type="password" name="password"><button>Sign in</button></form></body></html>`;
const NOT_FOUND = `<!doctype html><html><head><title>404: This page could not be found</title></head><body><h1>404</h1><p>This page could not be found.</p></body></html>`;
const ADMIN = `<!doctype html><html><head><title>Admin · Users</title></head><body><nav>Users Billing Settings</nav><table><tr><td>alice@acme.com</td><td>owner</td></tr></table></body></html>`;

/** Mutable server state so the test can "deploy a regression" between runs. */
const app = { adminProtected: true, apiUsersProtected: true, anonUsersDiffer: true };

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const html = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const redirectToLogin = () => {
    res.writeHead(307, { location: '/login' });
    res.end();
  };

  if (p === '/') return html(200, SHELL);
  if (p === '/login') return html(200, LOGIN);
  if (p === '/admin') return app.adminProtected ? redirectToLogin() : html(200, ADMIN);
  if (p === '/dashboard') return redirectToLogin(); // proper server-side guard
  if (p === '/settings') return html(200, LOGIN); // "200" but it is the sign-in form
  if (p === '/account') return html(200, SHELL); // SPA shell for every route
  if (p === '/profile') return html(200, NOT_FOUND); // soft-404
  if (p === '/api/me') return json(401, { error: 'unauthorized' });
  if (p === '/api/users') return app.apiUsersProtected ? json(401, { error: 'unauthorized' }) : json(200, [{ id: 1, email: 'alice@acme.com' }]);
  if (p === '/api/public') return json(200, { items: [{ id: 1 }], total: 1 }); // open API with data (custom target)
  if (p === '/api/orders') return json(200, { message: 'Forbidden', statusCode: 403 }); // 200 but error-shaped
  if (p.startsWith('/api/items/')) {
    const id = p.split('/').pop();
    return json(200, app.anonUsersDiffer ? { id, sku: `SKU-${id}` } : { id: 'x', sku: 'same' });
  }
  if (p === '/debug') return html(200, `<html><head><title>Debug</title></head><body><pre>NODE_ENV=production DATABASE_URL=postgres://…</pre></body></html>`);
  if (p === '/metrics') return html(503, '<html><body>down</body></html>');
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
}

let server: Server;

beforeAll(async () => {
  (process.env as Record<string, string>).NODE_ENV = 'test';
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  db.hostname = `127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const target = (path: string) => db.targets.find((t) => t.path === path)!;
const openFindings = () => db.findings.filter((f) => f.resolvedAt === null);

describe('auth prober — live end-to-end against a local app', () => {
  beforeEach(() => {
    // Custom (manual) targets on top of the seeded defaults.
    db.targets = [];
    db.findings = [];
    Object.assign(app, { adminProtected: true, apiUsersProtected: true, anonUsersDiffer: true });
  });

  it('probeTarget returns rich evidence over a real socket', async () => {
    const out = await probeTarget(db.hostname, '/settings');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.status).toBe(200);
    expect(out.evidence?.bodyKind).toBe('login_page');
    expect(out.evidence?.contentType).toContain('text/html');
    expect(out.evidence?.title).toBe('Sign in · Acme');

    const redirect = await probeTarget(db.hostname, '/dashboard');
    expect(redirect).toMatchObject({ ok: true, status: 307 });
    if (redirect.ok) expect(redirect.evidence?.location).toBe('/login');
  });

  it('night 1: seeds defaults, records baselines, flags only genuine exposures', async () => {
    // seed + a couple of manual targets
    const summary1 = await runAuthProber('proj_live');
    // manual targets added by the user after seeding
    const { seedProberTargets } = await import('@scanlyfix/db');
    await seedProberTargets('proj_live', [
      { path: '/api/public', method: 'GET', source: 'manual' },
      { path: '/api/items/[id]', method: 'GET', source: 'manual' },
    ]);
    const summary2 = await runAuthProber('proj_live');

    expect(summary1.errors).toBe(0);
    expect(summary2.errors).toBe(0);

    // Baselines recorded with verdict + reason
    expect(target('/dashboard').baselineStatus).toBe(307);
    expect(target('/api/me').baselineStatus).toBe(401);
    expect(target('/settings').lastVerdict).toBe('protected'); // 200 but it is the login form
    expect(target('/settings').lastReason).toMatch(/sign-in form/);
    expect(target('/account').lastVerdict).toBe('inconclusive'); // SPA shell
    expect(target('/account').lastReason).toMatch(/app shell/);
    expect(target('/profile').lastVerdict).toBe('inconclusive'); // soft-404
    expect(target('/api/orders').lastVerdict).toBe('protected'); // error-shaped JSON
    expect(target('/metrics').lastVerdict).toBe('inconclusive'); // 503

    // Findings: only the things that are actually open.
    const byPath = Object.fromEntries(openFindings().map((f) => [`${f.path}|${f.variant}`, f]));
    expect(Object.keys(byPath).sort()).toEqual(['/api/items/[id]|exposed', '/api/items/[id]|sequential_id', '/api/public|exposed', '/debug|exposed']);

    const debug = byPath['/debug|exposed']!;
    expect(debug.severity).toBe('critical');
    expect(debug.category).toBe('debug');
    expect(debug.evidence).toMatchObject({ bodyKind: 'html_app', title: 'Debug' });
    expect((debug.evidence as { bodySample: string }).bodySample).toContain('NODE_ENV=production');

    const idor = byPath['/api/items/[id]|sequential_id']!;
    expect(idor.reason).toMatch(/neighbouring ids/);
    const rem = buildRemediation({ path: idor.path, variant: 'sequential_id', actualStatus: idor.actualStatus, evidence: idor.evidence as never });
    expect(rem.fixPrompt).toContain('IDOR');

    // Nothing was flagged for the correctly-guarded or unjudgeable routes.
    expect(openFindings().some((f) => ['/dashboard', '/settings', '/account', '/profile', '/api/me', '/api/orders', '/admin'].includes(f.path))).toBe(false);

    // Dashboard tiles make sense
    const stats = summarizeTargets(db.targets, openFindings().length);
    expect(stats.total).toBe(db.targets.length);
    expect(stats.open).toBeGreaterThanOrEqual(3);
    expect(stats.inconclusive).toBeGreaterThanOrEqual(3);
    expect(stats.unbaselined).toBe(0);
  });

  it('night 2: a deploy removes the auth check → regression finding with evidence; night 3: fixed → auto-resolved', async () => {
    await runAuthProber('proj_live');
    expect(target('/admin').baselineStatus).toBe(307);
    expect(target('/api/users').baselineStatus).toBe(401);
    const before = openFindings().length;

    // "Deploy" a regression
    app.adminProtected = false;
    app.apiUsersProtected = false;
    const alerts: unknown[] = [];
    const s2 = await runAuthProber('proj_live', { onNewFindings: async (f) => void alerts.push(...f) });

    expect(s2.newFindings).toBe(2);
    expect(openFindings().length).toBe(before + 2);
    const admin = openFindings().find((f) => f.path === '/admin' && f.variant === null)!;
    expect(admin).toMatchObject({ baselineStatus: 307, actualStatus: 200, severity: 'critical', category: 'admin' });
    expect(admin.evidence).toMatchObject({ bodyKind: 'html_app', title: 'Admin · Users' });
    const users = openFindings().find((f) => f.path === '/api/users' && f.variant === null)!;
    expect(users).toMatchObject({ baselineStatus: 401, actualStatus: 200, category: 'api' });
    expect(alerts).toHaveLength(2);
    expect(target('/admin').lastVerdict).toBe('open');

    // Same state next night → no duplicate, still open
    const s2b = await runAuthProber('proj_live');
    expect(s2b.newFindings).toBe(0);
    expect(s2b.stillOpen).toBeGreaterThanOrEqual(2);

    // Fix it
    app.adminProtected = true;
    app.apiUsersProtected = true;
    const s3 = await runAuthProber('proj_live');
    expect(s3.autoResolved).toBe(2);
    expect(openFindings().some((f) => f.path === '/admin' || f.path === '/api/users')).toBe(false);
    expect(target('/admin').lastVerdict).toBe('protected');
  });

  it('exposed findings auto-resolve when the surface becomes protected, and sequential_id resolves when ids stop differing', async () => {
    const { seedProberTargets } = await import('@scanlyfix/db');
    await seedProberTargets('proj_live', [{ path: '/api/items/[id]', method: 'GET', source: 'manual' }]);
    await runAuthProber('proj_live');
    expect(openFindings().filter((f) => f.path === '/api/items/[id]').map((f) => f.variant).sort()).toEqual(['exposed', 'sequential_id']);

    app.anonUsersDiffer = false; // now every id returns the same record → not enumerable
    const s = await runAuthProber('proj_live');
    expect(s.autoResolved).toBe(1);
    expect(openFindings().filter((f) => f.path === '/api/items/[id]').map((f) => f.variant)).toEqual(['exposed']);
  });
});

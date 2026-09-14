/**
 * End-to-end: the real uptime engine against a real web server.
 *
 * `executeUptimeProbe` is the whole product — it probes, records, decides
 * whether the site is down, opens and closes incidents, and sends the email
 * that wakes someone at 3am. Until this file existed, none of that had a test.
 * The one named `monitoring-uptime-probe-deep.test.ts` only exercises
 * `evaluateOutcome`, a pure function two layers below the decisions that matter.
 *
 * So: a real HTTP server is started and flipped between healthy, broken, slow
 * and lying. The real `safeFetch` talks to it over a real socket. The engine is
 * the shipped one. Only the database is replaced — by an in-memory store that
 * reproduces the exact semantics of the queries it stands in for, each one
 * copied from the SQL and cited below, because a stand-in that is merely
 * plausible would let the engine pass while production fails.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── The site being monitored ───────────────────────────────────────────────

type SiteMode = 'healthy' | 'error500' | 'slow' | 'wrong-body' | 'redirect' | 'hang' | 'notfound';

const site = {
  mode: 'healthy' as SiteMode,
  body: '<html><body>Welcome to the shop</body></html>',
  hits: 0,
  lastMethod: '',
  lastHeaders: {} as Record<string, string | string[] | undefined>,
};

function handler(req: IncomingMessage, res: ServerResponse): void {
  site.hits++;
  site.lastMethod = req.method ?? '';
  site.lastHeaders = req.headers;

  // Where `redirect` mode points. Answering normally here is what makes the
  // hop terminate instead of looping.
  if (req.url === '/landed') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return void res.end(site.body);
  }

  switch (site.mode) {
    case 'error500':
      res.writeHead(500, { 'content-type': 'text/html' });
      return void res.end('Internal Server Error');
    case 'notfound':
      res.writeHead(404, { 'content-type': 'text/html' });
      return void res.end('Not Found');
    case 'redirect':
      res.writeHead(302, { location: '/landed' });
      return void res.end();
    case 'wrong-body':
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<html><body>Down for maintenance</body></html>');
    case 'slow':
      return void setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(site.body);
      }, 350);
    case 'hang':
      // Drops the connection without answering. Same catch path as a timeout,
      // without making the suite sit out the probe's full 15-second budget —
      // that budget is asserted separately, on the options the engine passes.
      return void req.socket.destroy();
    default:
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end(site.body);
  }
}

let server: Server;
let baseUrl = '';

// ── The database, in memory, with the real semantics ───────────────────────

type Run = { ok: boolean; statusCode: number | null; latencyMs: number; detail: string | null; ts: number };
type Incident = { id: string; startedAt: Date; resolvedAt: Date | null; durationMs: number | null; statusCode: number | null; detail: string | null };
type AlertRow = { id: string; kind: string; payload: Record<string, unknown>; dedupKey: string | null; createdAt: Date };

const store = {
  runs: [] as Run[],
  incidents: [] as Incident[],
  alerts: [] as AlertRow[],
  lastStatus: null as string | null,
  lastRunAt: null as Date | null,
  alertConfig: null as unknown,
  snoozed: false,
  maintenance: false,
  /** Alerts handed to the delivery layer, and subscriber notifications sent. */
  delivered: [] as string[],
  subscriberEmails: [] as { stage: string; headline: string; message: string }[],
  seq: 0,
};

function reset(): void {
  store.runs = [];
  store.incidents = [];
  store.alerts = [];
  store.lastStatus = null;
  store.lastRunAt = null;
  store.alertConfig = null;
  store.snoozed = false;
  store.maintenance = false;
  store.delivered = [];
  store.subscriberEmails = [];
  store.seq = 0;
  site.mode = 'healthy';
  site.hits = 0;
  fetchCalls.length = 0;
}

const id = (prefix: string) => `${prefix}-${++store.seq}`;

vi.mock('@scanlyfix/db', () => {
  const openIncidents = () => store.incidents.filter((i) => i.resolvedAt === null);

  return {
    // recordMonitorRun: inserts the event AND advances lastRunAt/lastStatus in
    // one transaction (monitors.ts:249).
    recordMonitorRun: vi.fn(async (_monitorId: string, outcome: { ok: boolean; statusCode: number | null; latencyMs: number; detail: string | null }) => {
      store.runs.push({ ...outcome, ts: Date.now() });
      store.lastRunAt = new Date();
      store.lastStatus = outcome.ok ? 'up' : 'down';
    }),

    // consecutiveFailures: newest first, stop at the first success, window of 10
    // (monitors.ts:290). The run just recorded IS counted — the engine calls
    // recordMonitorRun before this.
    consecutiveFailures: vi.fn(async (_monitorId: string, look = 10) => {
      let streak = 0;
      for (const run of [...store.runs].reverse().slice(0, look)) {
        if (run.ok) break;
        streak += 1;
      }
      return streak;
    }),

    // getOpenIncident: newest unresolved, or null (monitors.ts:410).
    getOpenIncident: vi.fn(async () => {
      const open = openIncidents().sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return open[0] ?? null;
    }),

    createIncident: vi.fn(async (_monitorId: string, meta: { statusCode?: number | null; detail?: string | null }) => {
      const incident: Incident = {
        id: id('incident'),
        startedAt: new Date(),
        resolvedAt: null,
        durationMs: null,
        statusCode: meta.statusCode ?? null,
        detail: meta.detail ?? null,
      };
      store.incidents.push(incident);
      return { id: incident.id, startedAt: incident.startedAt };
    }),

    // resolveIncident: resolves ALL open incidents and returns them with
    // durations (monitors.ts:357). A no-op when none are open.
    resolveIncident: vi.fn(async () => {
      const now = new Date();
      const resolved = [];
      for (const incident of openIncidents().sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())) {
        incident.durationMs = now.getTime() - incident.startedAt.getTime();
        incident.resolvedAt = now;
        resolved.push({
          id: incident.id,
          startedAt: incident.startedAt,
          durationMs: incident.durationMs,
          statusCode: incident.statusCode,
          detail: incident.detail,
        });
      }
      return resolved;
    }),

    // recordAlertOnce: 'downtime' and 'recovered' skip dedup when no dedupKey
    // is given; a dedupKey dedupes on itself; anything else is once per project
    // per kind per UTC day (alerts.ts:40).
    recordAlertOnce: vi.fn(async (input: { kind: string; payload: Record<string, unknown>; dedupKey?: string | null }) => {
      const EXEMPT = new Set(['downtime', 'recovered']);
      if (!input.dedupKey && EXEMPT.has(input.kind)) {
        // always create
      } else if (input.dedupKey) {
        if (store.alerts.some((a) => a.dedupKey === input.dedupKey)) return null;
      } else {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        if (store.alerts.some((a) => a.kind === input.kind && a.createdAt >= startOfDay)) return null;
      }
      const row: AlertRow = {
        id: id('alert'),
        kind: input.kind,
        payload: input.payload,
        dedupKey: input.dedupKey ?? null,
        createdAt: new Date(),
      };
      store.alerts.push(row);
      return row;
    }),

    isMonitorSnoozed: vi.fn(async () => store.snoozed),
    isInMaintenanceWindow: vi.fn(async () => store.maintenance),
    getAlertChannels: vi.fn(async () => [{ id: 'email-1', enabled: true }]),

    monitors: {},
    projects: {},
    db: {
      query: {
        monitors: { findFirst: vi.fn(async () => ({ alertConfig: store.alertConfig })) },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ name: 'Shop', url: 'https://shop.test', slug: 'shop' }],
          }),
        }),
      }),
    },
  };
});

vi.mock('@/lib/alert-email.ts', () => ({
  deliverAlert: vi.fn(async (alertId: string) => {
    store.delivered.push(alertId);
  }),
  resolveNotifyChannels: vi.fn(() => ['email-1']),
}));

vi.mock('@/lib/status-subscriber-email.ts', () => ({
  notifyConfirmedSubscribersForMonitor: vi.fn(async (input: { email: { stage: string; headline: string; message: string } }) => {
    store.subscriberEmails.push(input.email);
  }),
}));

/**
 * Real HTTP, without the SSRF guard that exists to stop us reaching 127.0.0.1.
 *
 * `safeFetch` refuses private and loopback addresses outright (ssrf-guard.ts:195)
 * — correctly, and that refusal is what stops a customer pointing a monitor at
 * our own metadata endpoint. It also makes it impossible to probe a test server.
 *
 * So the guard is the one thing replaced. Everything else is genuine: a real
 * socket to a real server, real status codes, real bodies, real redirect
 * following, a real abort on timeout. The options the engine passes are recorded
 * so the tests can assert on what it actually asked for.
 */
const fetchCalls: Array<Record<string, unknown>> = [];

vi.mock('@scanlyfix/checks', () => ({
  safeFetch: async (url: string, opts: Record<string, unknown> = {}) => {
    fetchCalls.push({ url, ...opts });
    const response = await fetch(url, {
      method: (opts.method as string) ?? 'GET',
      redirect: opts.followRedirects === false ? 'manual' : 'follow',
      headers: (opts.headers as Record<string, string>) ?? {},
      signal: AbortSignal.timeout((opts.timeoutMs as number) ?? 15_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text.slice(0, (opts.maxBodyBytes as number) ?? 4096),
      headers: response.headers,
      truncated: false,
      requestedUrl: new URL(url),
      finalUrl: new URL(response.url || url),
      redirectChain: [],
    };
  },
}));

vi.mock('@/lib/header-encryption.ts', () => ({
  // The real one decrypts; the shape is what matters here.
  prepareHeaders: vi.fn((headers: Array<{ key: string; valueEncrypted: string }>) =>
    Object.fromEntries(headers.map((h) => [h.key, h.valueEncrypted])),
  ),
}));

import { executeUptimeProbe } from '../lib/uptime-probe-core.ts';

const MONITOR = { monitorId: 'monitor-1', projectId: 'project-1' };
const probe = () => executeUptimeProbe({ ...MONITOR, url: baseUrl });

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${addr.port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(reset);
afterEach(() => vi.clearAllMocks());

const alertKinds = () => store.alerts.map((a) => a.kind);
const openIncidentCount = () => store.incidents.filter((i) => i.resolvedAt === null).length;

// ── A site that is up ──────────────────────────────────────────────────────

describe('a healthy site', () => {
  it('is reported up, with a real status code and latency', async () => {
    const result = await probe();
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(site.hits).toBe(1);
  });

  it('records the run and moves the monitor to up', async () => {
    await probe();
    expect(store.runs).toHaveLength(1);
    expect(store.lastStatus).toBe('up');
    expect(store.lastRunAt).not.toBeNull();
  });

  it('opens no incident and sends no email, however many times it is checked', async () => {
    for (let i = 0; i < 5; i++) await probe();
    expect(store.incidents).toEqual([]);
    expect(store.alerts).toEqual([]);
    expect(store.subscriberEmails).toEqual([]);
  });

  it('follows a redirect and judges the page it lands on', async () => {
    // A site that moved to www or forced https is not down, and reporting the
    // 302 instead of what it leads to would page someone over a DNS change.
    site.mode = 'redirect';
    const result = await probe();
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('reports the redirect itself when the customer turned following off', async () => {
    store.alertConfig = { followRedirects: false };
    site.mode = 'redirect';
    const result = await probe();
    expect(result.statusCode).toBe(302);
    // 3xx is not a failure under the default status policy.
    expect(result.ok).toBe(true);
  });
});

// ── A site that goes down ──────────────────────────────────────────────────

describe('a site that goes down', () => {
  it('alerts on the first failure by default, and opens one incident', async () => {
    site.mode = 'error500';
    const result = await probe();

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.detail).toBe('HTTP 500');
    expect(result.alerted).toBe(true);
    expect(result.streak).toBe(1);
    expect(alertKinds()).toEqual(['downtime']);
    expect(openIncidentCount()).toBe(1);
  });

  it('tells the status page subscribers, once, with what was observed', async () => {
    site.mode = 'error500';
    await probe();
    expect(store.subscriberEmails).toHaveLength(1);
    expect(store.subscriberEmails[0]?.stage).toBe('investigating');
    expect(store.subscriberEmails[0]?.message).toContain('HTTP 500');
  });

  it('does not email again on every subsequent failed check', async () => {
    // The dedup key is the incident id, so a site down for an hour on a
    // one-minute interval produces one email, not sixty.
    site.mode = 'error500';
    for (let i = 0; i < 10; i++) await probe();

    expect(alertKinds().filter((k) => k === 'downtime')).toHaveLength(1);
    expect(store.subscriberEmails).toHaveLength(1);
    expect(openIncidentCount()).toBe(1);
    expect(store.runs).toHaveLength(10);
  });

  it('hands the alert to the delivery layer', async () => {
    site.mode = 'error500';
    await probe();
    expect(store.delivered).toHaveLength(1);
  });
});

// ── failuresBeforeAlert ────────────────────────────────────────────────────

describe('failuresBeforeAlert', () => {
  beforeEach(() => {
    store.alertConfig = { failuresBeforeAlert: 3 };
  });

  it('stays quiet until the configured number of failures in a row', async () => {
    site.mode = 'error500';

    const first = await probe();
    expect(first.alerted).toBe(false);
    expect(first.streak).toBe(1);

    const second = await probe();
    expect(second.alerted).toBe(false);
    expect(second.streak).toBe(2);

    const third = await probe();
    expect(third.alerted).toBe(true);
    expect(third.streak).toBe(3);
  });

  it('opens no incident before the threshold is reached', async () => {
    // An incident opened on failure one would show on the status page and in
    // the downtime history for a blip the customer asked us to ignore.
    site.mode = 'error500';
    await probe();
    await probe();
    expect(store.incidents).toEqual([]);

    await probe();
    expect(openIncidentCount()).toBe(1);
  });

  it('resets the streak when a single check succeeds', async () => {
    site.mode = 'error500';
    await probe();
    await probe();

    site.mode = 'healthy';
    await probe();

    site.mode = 'error500';
    const next = await probe();
    expect(next.streak).toBe(1);
    expect(next.alerted).toBe(false);
    expect(store.alerts).toEqual([]);
  });

  it('ignores a configured value outside the allowed range', async () => {
    store.alertConfig = { failuresBeforeAlert: 99 };
    site.mode = 'error500';
    const result = await probe();
    // Out of range falls back to the default of 1 rather than muting the
    // monitor forever.
    expect(result.alerted).toBe(true);
  });
});

// ── Recovery ───────────────────────────────────────────────────────────────

describe('recovery', () => {
  it('resolves the incident, says how long it was down, and emails once', async () => {
    site.mode = 'error500';
    await probe();
    expect(openIncidentCount()).toBe(1);

    site.mode = 'healthy';
    const result = await probe();

    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.downFor).toBeTruthy();
    expect(openIncidentCount()).toBe(0);
    expect(alertKinds()).toEqual(['downtime', 'recovered']);
  });

  it('tells the subscribers it is back', async () => {
    site.mode = 'error500';
    await probe();
    site.mode = 'healthy';
    await probe();

    expect(store.subscriberEmails.map((e) => e.stage)).toEqual(['investigating', 'resolved']);
    expect(store.subscriberEmails[1]?.headline).toMatch(/back up/i);
  });

  it('does not send a second recovery email on the next healthy check', async () => {
    // 'recovered' is exempt from daily dedup, so nothing but an empty
    // resolveIncident stops a repeat. This pins that.
    site.mode = 'error500';
    await probe();
    site.mode = 'healthy';
    await probe();
    await probe();
    await probe();

    expect(alertKinds().filter((k) => k === 'recovered')).toHaveLength(1);
  });

  it('sends no recovery email for a site that was never down', async () => {
    site.mode = 'healthy';
    await probe();
    await probe();
    expect(store.alerts).toEqual([]);
  });
});

// ── Flapping ───────────────────────────────────────────────────────────────

describe('a site that flaps', () => {
  it('emails on every transition, which is a real cost worth knowing', async () => {
    // Up/down/up/down for ten cycles on a one-minute interval. Each transition
    // is a genuine state change, so each one is a genuine email — but that is
    // forty emails an hour to the owner's phone, and the only supported defence
    // is failuresBeforeAlert.
    for (let i = 0; i < 10; i++) {
      site.mode = 'error500';
      await probe();
      site.mode = 'healthy';
      await probe();
    }

    expect(alertKinds().filter((k) => k === 'downtime')).toHaveLength(10);
    expect(alertKinds().filter((k) => k === 'recovered')).toHaveLength(10);
    // Every incident was closed — none leaked.
    expect(openIncidentCount()).toBe(0);
    expect(store.incidents).toHaveLength(10);
  });

  it('is quietened by failuresBeforeAlert, which is the documented answer', async () => {
    store.alertConfig = { failuresBeforeAlert: 3 };
    for (let i = 0; i < 10; i++) {
      site.mode = 'error500';
      await probe();
      site.mode = 'healthy';
      await probe();
    }
    // A single failure never reaches the threshold, so nothing is sent at all.
    expect(store.alerts).toEqual([]);
    expect(store.incidents).toEqual([]);
  });
});

// ── Snooze and maintenance ─────────────────────────────────────────────────

describe('snooze', () => {
  it('suppresses the email but still records the outage', async () => {
    store.snoozed = true;
    site.mode = 'error500';
    const result = await probe();

    expect(result.alerted).toBe(false);
    expect(result.snoozed).toBe(true);
    expect(store.alerts).toEqual([]);
    // The run is still recorded, so the uptime percentage stays honest.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]?.ok).toBe(false);
  });

  it('opens no incident while snoozed, so nothing is left dangling', async () => {
    // An incident opened but never alerted on would sit open until the site
    // recovered, and would then fire a recovery email for an outage the
    // customer was never told about.
    store.snoozed = true;
    site.mode = 'error500';
    await probe();
    await probe();
    expect(store.incidents).toEqual([]);

    store.snoozed = false;
    site.mode = 'healthy';
    const recovery = await probe();
    expect(recovery.recovered).toBe(false);
    expect(store.alerts).toEqual([]);
  });

  it('alerts normally again once the snooze ends', async () => {
    store.snoozed = true;
    site.mode = 'error500';
    await probe();

    store.snoozed = false;
    const result = await probe();
    expect(result.alerted).toBe(true);
    expect(openIncidentCount()).toBe(1);
  });
});

describe('maintenance windows', () => {
  it('suppress the email and the incident', async () => {
    store.maintenance = true;
    site.mode = 'error500';
    const result = await probe();

    expect(result.maintenance).toBe(true);
    expect(result.alerted).toBe(false);
    expect(store.alerts).toEqual([]);
    expect(store.incidents).toEqual([]);
  });

  it('do not suppress the recovery of an incident opened before the window', async () => {
    site.mode = 'error500';
    await probe();
    expect(openIncidentCount()).toBe(1);

    store.maintenance = true;
    site.mode = 'healthy';
    const result = await probe();

    // The incident must close whatever the window says — leaving it open would
    // show the site as down on the status page after it came back.
    expect(openIncidentCount()).toBe(0);
    expect(result.ok).toBe(true);
    // But the customer is not emailed during their own maintenance window.
    expect(alertKinds()).toEqual(['downtime']);
  });
});

// ── What counts as down ────────────────────────────────────────────────────

describe('what counts as down', () => {
  it('a connection that is refused', async () => {
    const result = await executeUptimeProbe({ ...MONITOR, url: 'http://127.0.0.1:1/' });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.detail).toBeTruthy();
  });

  it('a server that drops the connection mid-request', async () => {
    site.mode = 'hang';
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeNull();
    expect(result.detail).toBeTruthy();
  });

  it('is given a bounded budget, so one dead host cannot stall the sweep', async () => {
    await probe();
    expect(fetchCalls[0]?.timeoutMs).toBe(15_000);
  });

  it('a URL that does not parse, without a request going out', async () => {
    const before = site.hits;
    const result = await executeUptimeProbe({ ...MONITOR, url: 'not a url' });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('unparseable project URL');
    expect(site.hits).toBe(before);
    // Nothing is recorded for a monitor that could never have been probed.
    expect(store.runs).toEqual([]);
  });

  it('a 404, under the default policy', async () => {
    site.mode = 'notfound';
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('HTTP 404');
  });
});

// ── Custom checks ──────────────────────────────────────────────────────────

describe('keyword checks', () => {
  it('call a 200 that lost its content down', async () => {
    // The failure mode a status code cannot see: the server is up, the page
    // renders, and the thing the customer sells is missing from it.
    store.alertConfig = { keywordCheck: { type: 'should_contain', value: 'Welcome to the shop' } };
    site.mode = 'wrong-body';

    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.detail).toMatch(/keyword/i);
  });

  it('pass when the content is there', async () => {
    store.alertConfig = { keywordCheck: { type: 'should_contain', value: 'Welcome to the shop' } };
    site.mode = 'healthy';
    expect((await probe()).ok).toBe(true);
  });

  it('catch a page that should NOT say something', async () => {
    store.alertConfig = { keywordCheck: { type: 'should_not_contain', value: 'Down for maintenance' } };
    site.mode = 'wrong-body';
    expect((await probe()).ok).toBe(false);
  });
});

describe('latency thresholds', () => {
  it('call a slow site down and say by how much', async () => {
    store.alertConfig = { maxLatencyMs: 100 };
    site.mode = 'slow';
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/threshold/);
    expect(result.latencyMs).toBeGreaterThan(100);
  });

  it('leave a fast site alone', async () => {
    store.alertConfig = { maxLatencyMs: 5_000 };
    expect((await probe()).ok).toBe(true);
  });
});

describe('custom status-code policy', () => {
  it('can accept a 404 as healthy', async () => {
    store.alertConfig = { expectedStatusCodes: [404] };
    site.mode = 'notfound';
    expect((await probe()).ok).toBe(true);
  });

  it('can treat a 200 as down when something else was expected', async () => {
    store.alertConfig = { expectedStatusCodes: [201] };
    site.mode = 'healthy';
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('expected');
  });

  it('can single out only the codes that matter', async () => {
    store.alertConfig = { failStatusCodes: [503] };
    site.mode = 'notfound';
    // 404 is not on the fail list, so under this policy the site is up.
    expect((await probe()).ok).toBe(true);
  });
});

describe('request options', () => {
  it('sends GET by default', async () => {
    await probe();
    expect(site.lastMethod).toBe('GET');
  });

  it('sends HEAD when the customer chose it', async () => {
    // This was decoration for the life of the feature: the engine read
    // httpMethod into a local and never passed it on, and safeFetch had no
    // method option at all, so a customer monitoring a heavy page pulled the
    // whole body every minute regardless of what the dropdown said.
    store.alertConfig = { httpMethod: 'HEAD' };
    await probe();
    expect(site.lastMethod).toBe('HEAD');
    expect(fetchCalls[0]?.method).toBe('HEAD');
  });

  it('overrides HEAD when the check needs a body', async () => {
    // A HEAD response has no body, so a keyword check against one could never
    // pass — the site would be reported down forever.
    store.alertConfig = {
      httpMethod: 'HEAD',
      keywordCheck: { type: 'should_contain', value: 'Welcome to the shop' },
    };
    const result = await probe();
    expect(site.lastMethod).toBe('GET');
    expect(result.ok).toBe(true);
  });

  it('sends configured custom headers', async () => {
    store.alertConfig = {
      customHeaders: [{ key: 'X-Probe-Token', valueEncrypted: 'secret-value' }],
    };
    await probe();
    expect(site.lastHeaders['x-probe-token']).toBe('secret-value');
  });

  it('asks for only a small body when there is no content check', async () => {
    await probe();
    expect(fetchCalls[0]?.maxBodyBytes).toBe(4096);

    fetchCalls.length = 0;
    store.alertConfig = { keywordCheck: { type: 'should_contain', value: 'shop' } };
    await probe();
    expect(fetchCalls[0]?.maxBodyBytes).toBe(65536);
  });
});

// ── Reminders ──────────────────────────────────────────────────────────────

describe('downtime reminders', () => {
  it('are not sent inside the first interval', async () => {
    store.alertConfig = { reminderIntervalMin: 15 };
    site.mode = 'error500';
    await probe();
    await probe();
    await probe();
    expect(alertKinds().filter((k) => k === 'downtime-reminder')).toHaveLength(0);
  });

  it('are sent once per elapsed interval, not once per check', async () => {
    store.alertConfig = { reminderIntervalMin: 15 };
    site.mode = 'error500';
    await probe();

    // Backdate the incident by 40 minutes: two full 15-minute slots have passed.
    const incident = store.incidents[0]!;
    incident.startedAt = new Date(Date.now() - 40 * 60_000);

    // Five more checks inside the same slot must produce exactly one reminder.
    for (let i = 0; i < 5; i++) await probe();
    expect(alertKinds().filter((k) => k === 'downtime-reminder')).toHaveLength(1);

    // Crossing into the next slot produces one more.
    incident.startedAt = new Date(Date.now() - 55 * 60_000);
    await probe();
    expect(alertKinds().filter((k) => k === 'downtime-reminder')).toHaveLength(2);
  });

  it('stop when the site recovers', async () => {
    store.alertConfig = { reminderIntervalMin: 15 };
    site.mode = 'error500';
    await probe();
    store.incidents[0]!.startedAt = new Date(Date.now() - 40 * 60_000);
    await probe();

    site.mode = 'healthy';
    await probe();
    const remindersBefore = alertKinds().filter((k) => k === 'downtime-reminder').length;

    await probe();
    await probe();
    expect(alertKinds().filter((k) => k === 'downtime-reminder')).toHaveLength(remindersBefore);
  });
});

// ── Robustness ─────────────────────────────────────────────────────────────

describe('the engine survives its own dependencies failing', () => {
  it('still reports the outage when the email layer throws', async () => {
    const { deliverAlert } = await import('../lib/alert-email.ts');
    vi.mocked(deliverAlert).mockRejectedValueOnce(new Error('SMTP down'));

    site.mode = 'error500';
    const result = await probe();

    // A mail provider outage must not also cost us the record of the incident.
    expect(result.ok).toBe(false);
    expect(store.runs).toHaveLength(1);
    expect(openIncidentCount()).toBe(1);
  });

  it('still records the run when the subscriber notifier throws', async () => {
    const { notifyConfirmedSubscribersForMonitor } = await import('../lib/status-subscriber-email.ts');
    vi.mocked(notifyConfirmedSubscribersForMonitor).mockRejectedValueOnce(new Error('boom'));

    site.mode = 'error500';
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(store.runs).toHaveLength(1);
  });

  it('treats a malformed alertConfig as no config rather than failing the check', async () => {
    // The column is jsonb and older rows may hold anything.
    store.alertConfig = { failuresBeforeAlert: 'three', maxLatencyMs: 'fast', nonsense: true };
    site.mode = 'error500';
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.alerted).toBe(true);
  });
});

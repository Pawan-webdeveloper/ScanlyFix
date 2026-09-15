/**
 * The canary engine, end to end against a real PostgREST-shaped server.
 *
 * This file used to drive the engine through a mocked `restSelect` and a queue
 * of canned responses, which coupled every test to the exact number and order of
 * HTTP calls: adding one request anywhere broke tests that had nothing to say
 * about it. Worse, a mock of the HTTP function cannot check the things most
 * likely to be wrong — the query strings, which key is used, how a count is
 * read, or what a 404 on one table versus another actually does.
 *
 * So the database of the customer is a real HTTP server here, and only our own
 * persistence layer is in memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordTrigger, startFakeSupabase, type FakeSupabase } from './support/fake-supabase.ts';

// ── Our own storage, in memory ──────────────────────────────────────────────
type CanaryRow = { id: string; markerToken: string; honeytokenPath: string; kind: string; status: string };
type EventRow = { projectId: string; canaryId: string | null; kind: string; detail: string; source: string; at: number };

const store = {
  config: null as { supabaseUrl: string; serviceKey: string; anonKey: string | null; snapshot: unknown } | null,
  canaries: [] as CanaryRow[],
  events: [] as EventRow[],
  snapshot: null as Record<string, unknown> | null,
  statusWrites: [] as Array<{ marker: string; status: string; integrity: string }>,
};

vi.mock('@scanlyfix/db', () => ({
  getCanaryProjectConfig: async () => store.config,
  listCanaries: async () => store.canaries.filter((c) => c.status !== 'retired'),
  updateCanaryStatus: async (_p: string, marker: string, status: string, integrity: string) => {
    store.statusWrites.push({ marker, status, integrity });
    const row = store.canaries.find((c) => c.markerToken === marker);
    if (row) row.status = status;
  },
  insertCanaryEvents: async (events: EventRow[]) => {
    for (const e of events) store.events.push({ ...e, at: Date.now() });
    return events.length;
  },
  markCanariesSetup: async (_p: string, snapshot: Record<string, unknown>) => {
    store.snapshot = snapshot;
  },
  hasRecentDuplicateEvent: async (_p: string, kind: string, detail: string) =>
    store.events.some((e) => e.kind === kind && e.detail === detail),
}));

vi.mock('@/lib/header-encryption', () => ({ decryptValue: (v: string) => v }));

import { runCanaryCheck } from '@/lib/runtime/canaries/engine';
import { sha256Canonical } from '@/lib/runtime/canaries/integrity';
import { SELFTEST_KIND } from '@/lib/runtime/canaries/types';

const PROJECT = 'proj_canary_live';
const MARKERS = ['CANARY::proj1234::A', 'CANARY::proj1234::B', 'CANARY::proj1234::C'];
const SELFTEST_MARKER = 'CANARY::proj1234::SELFTEST';

let fake: FakeSupabase | null = null;

function connect(f: FakeSupabase, snapshot: unknown = null): void {
  store.config = { supabaseUrl: f.url, serviceKey: f.state.serviceKey, anonKey: f.state.anonKey, snapshot };
}

async function boot(overrides: Parameters<typeof startFakeSupabase>[0] = {}): Promise<FakeSupabase> {
  const f = await startFakeSupabase({
    canaryRows: [
      ...MARKERS.map((marker, i) => ({ marker, payload: { note: 'legacy integration backup', api_key: `sk-${i}` } })),
      { marker: SELFTEST_MARKER, payload: { note: 'self test', nonce: 'initial' } },
    ],
    ...overrides,
  });
  store.canaries = [
    ...MARKERS.map((m, i) => ({ id: `c${i}`, markerToken: m, honeytokenPath: `h${i}`, kind: 'vault', status: 'planted' })),
    { id: 'cself', markerToken: SELFTEST_MARKER, honeytokenPath: 'hself', kind: SELFTEST_KIND, status: 'planted' },
  ];
  return f;
}

/** A snapshot matching what the verify route writes after a successful setup. */
function baselineSnapshot(f: FakeSupabase, lastLogId = 0): Record<string, unknown> {
  const hashes: Record<string, string> = {};
  for (const row of f.state.canaryRows) {
    if (row.marker === SELFTEST_MARKER) continue;
    // Mirrors sha256Canonical over the same payloads.
    hashes[row.marker] = sha256Canonical(row.payload);
  }
  return { payloadHashes: hashes, logRowCount: f.state.logRows.length, lastLogId, takenAt: new Date().toISOString() };
}

const kinds = (detections: Array<{ kind: string }>) => detections.map((d) => d.kind).sort();
const summaryHasBrokenChain = (s: { detections: Array<{ kind: string }> }) => s.detections.some((d) => d.kind === 'watch_disabled');

beforeEach(() => {
  store.config = null;
  store.canaries = [];
  store.events = [];
  store.snapshot = null;
  store.statusWrites = [];
});

afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe('runCanaryCheck — a healthy database', () => {
  it('reports nothing, records no event, and moves the baseline forward', async () => {
    fake = await boot();
    connect(fake, baselineSnapshot(fake));

    const summary = await runCanaryCheck(PROJECT);

    expect(summary.reachable).toBe(true);
    expect(summary.detections).toEqual([]);
    expect(store.events).toEqual([]);
    expect(store.snapshot).toBeTruthy();
  });

  it('proves the chain is armed by writing the self-test row and checking the trigger saw it', async () => {
    fake = await boot();
    connect(fake, baselineSnapshot(fake));

    await runCanaryCheck(PROJECT);

    const patchRequests = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patchRequests).toHaveLength(1);
    expect(patchRequests[0]?.path).toContain(encodeURIComponent(SELFTEST_MARKER));
    expect(patchRequests[0]?.key).toBe('service');

    // The fake database fires its trigger the way the real one does, so the
    // self-test finds its own entry and raises nothing.
    expect(summaryHasBrokenChain(await runCanaryCheck(PROJECT))).toBe(false);
  });

  it('never reports its own self-test writes as an intrusion', async () => {
    fake = await boot();
    // The trigger logged the self-test's own write from a previous run.
    recordTrigger(fake.state, { marker: SELFTEST_MARKER, action: 'UPDATE', oldPayload: {}, actedAt: '2026-09-15T02:30:00Z' });
    connect(fake, baselineSnapshot(fake, 0));

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.filter((d) => d.kind === 'modified')).toEqual([]);
  });
});

describe('runCanaryCheck — the trigger log is the evidence', () => {
  it('reports a modify-then-restore that the payload hashes cannot see', async () => {
    fake = await boot();
    const snapshot = baselineSnapshot(fake);
    // The attacker changed row A and put it back. Current state is identical…
    recordTrigger(fake.state, { marker: MARKERS[0]!, action: 'UPDATE', oldPayload: {}, actedAt: '2026-09-15T14:00:00Z' });
    recordTrigger(fake.state, { marker: MARKERS[0]!, action: 'UPDATE', oldPayload: {}, actedAt: '2026-09-15T14:05:00Z' });
    connect(fake, snapshot);

    const summary = await runCanaryCheck(PROJECT);

    // …but the log proves it happened, twice, with the times.
    const logDetections = summary.detections.filter((d) => d.source === 'trigger_log');
    expect(logDetections).toHaveLength(2);
    expect(logDetections[0]?.kind).toBe('modified');
    expect(logDetections[0]?.occurredAt).toBe('2026-09-15T14:00:00Z');
    expect(logDetections[0]?.detail).toContain('14:00');
    expect(logDetections[0]?.canaryId).toBe('c0');
  });

  it('distinguishes a delete from a modification using the operation the trigger recorded', async () => {
    fake = await boot();
    const snapshot = baselineSnapshot(fake);
    recordTrigger(fake.state, { marker: MARKERS[1]!, action: 'DELETE', oldPayload: {}, actedAt: '2026-09-15T03:00:00Z' });
    fake.state.canaryRows = fake.state.canaryRows.filter((r) => r.marker !== MARKERS[1]);
    connect(fake, snapshot);

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.kind === 'deleted' && d.source === 'trigger_log')).toBe(true);
    // One touch, one event: the state comparison does not double-report it.
    expect(summary.detections.filter((d) => d.marker === MARKERS[1])).toHaveLength(1);
  });

  it('advances the watermark so the same log rows are never reported twice', async () => {
    fake = await boot();
    recordTrigger(fake.state, { marker: MARKERS[0]!, action: 'UPDATE', oldPayload: {}, actedAt: '2026-09-15T14:00:00Z' });
    connect(fake, baselineSnapshot(fake));

    const first = await runCanaryCheck(PROJECT);
    expect(first.detections.filter((d) => d.source === 'trigger_log')).toHaveLength(1);

    connect(fake, store.snapshot);
    const second = await runCanaryCheck(PROJECT);
    expect(second.detections.filter((d) => d.source === 'trigger_log')).toEqual([]);
  });

  it('summarises rather than inserting a row each when an intruder writes in a loop', async () => {
    fake = await boot();
    const snapshot = baselineSnapshot(fake);
    for (let i = 0; i < 60; i++) {
      recordTrigger(fake.state, { marker: MARKERS[0]!, action: 'UPDATE', oldPayload: {}, actedAt: `2026-09-15T14:${String(i).padStart(2, '0')}:00Z` });
    }
    connect(fake, snapshot);

    const summary = await runCanaryCheck(PROJECT);
    const logDetections = summary.detections.filter((d) => d.source === 'trigger_log');
    // Capped, and the overflow is stated rather than dropped silently.
    expect(logDetections.length).toBeLessThanOrEqual(26);
    expect(logDetections.some((d) => /further decoy-row writes/.test(d.detail))).toBe(true);
  });

  it('reports a log that shrank as someone covering their tracks', async () => {
    fake = await boot();
    for (let i = 0; i < 5; i++) {
      recordTrigger(fake.state, { marker: MARKERS[0]!, action: 'UPDATE', oldPayload: {}, actedAt: '2026-09-15T01:00:00Z' });
    }
    const snapshot = { ...baselineSnapshot(fake, 99), logRowCount: 12 };
    connect(fake, snapshot);

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.kind === 'log_wiped')).toBe(true);
  });
});

describe('runCanaryCheck — state comparison', () => {
  it('reports a payload that changed with no log entry, which means the trigger was bypassed', async () => {
    fake = await boot();
    const snapshot = baselineSnapshot(fake);
    fake.state.canaryRows = fake.state.canaryRows.map((r) =>
      r.marker === MARKERS[0] ? { ...r, payload: { note: 'tampered' } } : r,
    );
    connect(fake, snapshot);

    const summary = await runCanaryCheck(PROJECT);
    const detection = summary.detections.find((d) => d.kind === 'modified');
    expect(detection?.source).toBe('integrity');
    expect(detection?.marker).toBe(MARKERS[0]);
    expect(detection?.canaryId).toBe('c0');
    expect(store.statusWrites).toContainEqual({ marker: MARKERS[0]!, status: 'compromised', integrity: 'modified' });
  });

  it('still compares payloads on a snapshot written before the log watermark existed', async () => {
    fake = await boot();
    const legacy = baselineSnapshot(fake);
    delete legacy.lastLogId; // exactly what older snapshots look like
    fake.state.canaryRows = fake.state.canaryRows.map((r) =>
      r.marker === MARKERS[0] ? { ...r, payload: { note: 'tampered' } } : r,
    );
    connect(fake, legacy);

    // Treating a missing watermark as "no snapshot" would rebaseline the
    // tampered row and lose the detection permanently.
    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.kind === 'modified')).toBe(true);
  });

  it('looks for a marker the snapshot forgot, because the canaries table is the roster', async () => {
    fake = await boot();
    const snapshot = baselineSnapshot(fake);
    delete (snapshot.payloadHashes as Record<string, string>)[MARKERS[2]!];
    fake.state.canaryRows = fake.state.canaryRows.filter((r) => r.marker !== MARKERS[2]);
    connect(fake, snapshot);

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.kind === 'deleted' && d.marker === MARKERS[2])).toBe(true);
  });
});

describe('runCanaryCheck — when the detector itself is broken', () => {
  it('says so when the decoy table is gone, and stops showing the rows as healthy', async () => {
    fake = await boot({ canaryTableExists: false });
    connect(fake, null);

    const summary = await runCanaryCheck(PROJECT);
    expect(kinds(summary.detections)).toContain('table_missing');
    expect(store.statusWrites.every((w) => w.status === 'compromised' && w.integrity === 'missing')).toBe(true);
    expect(store.snapshot).toBeNull();
  });

  it('says so when the database cannot be reached, instead of reporting all quiet', async () => {
    fake = await boot({ failWith: { status: 503, times: 99 } });
    connect(fake, null);

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.reachable).toBe(false);
    expect(kinds(summary.detections)).toContain('unreachable');
    // Nothing is judged and the baseline is untouched.
    expect(store.snapshot).toBeNull();
    expect(store.statusWrites.every((w) => w.integrity === 'unreachable')).toBe(true);
  });

  it('says so when there is no usable connection at all', async () => {
    store.config = null;
    const summary = await runCanaryCheck(PROJECT);
    expect(kinds(summary.detections)).toEqual(['watch_disabled']);
    expect(store.events).toHaveLength(1);
  });
});

describe('runCanaryCheck — the self-test proves the chain is armed', () => {
  it('reports a dropped trigger, which otherwise looks exactly like a quiet night', async () => {
    // The decoy rows are intact and the log has not shrunk, so every other
    // signal says "all clear". Only writing to the table and finding that the
    // trigger recorded nothing can tell the difference.
    fake = await boot({ triggerDisabled: true });
    connect(fake, baselineSnapshot(fake));

    const summary = await runCanaryCheck(PROJECT);

    const broken = summary.detections.find((d) => d.kind === 'watch_disabled');
    expect(broken).toBeTruthy();
    expect(broken?.detail).toMatch(/trigger recorded nothing/i);
    expect(broken?.canaryId).toBe('cself');
  });

  it('reports a log table that can no longer be read', async () => {
    fake = await boot();
    connect(fake, baselineSnapshot(fake));
    // The decoy table answers perfectly; only the log table is gone.
    fake.state.logTableExists = false;

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.kind === 'watch_disabled')).toBe(true);
  });

  it('stays silent when the chain responds, and never bills its own write as an intrusion', async () => {
    fake = await boot();
    connect(fake, baselineSnapshot(fake));

    const first = await runCanaryCheck(PROJECT);
    expect(first.detections).toEqual([]);

    // Second run, carrying the snapshot the first one wrote: the self-test's own
    // log row from run one is inside the window and must not be reported.
    connect(fake, store.snapshot);
    const second = await runCanaryCheck(PROJECT);
    expect(second.detections).toEqual([]);
  });
});

describe('runCanaryCheck — anonymous access to the decoy table', () => {
  it('reports a readable decoy table as an RLS hole', async () => {
    fake = await boot({ anonReadable: { scanlyfix_canaries: 3 } });
    connect(fake, baselineSnapshot(fake));

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.kind === 'anon_readable')).toBe(true);
  });

  it('treats an empty 200 as the policy working, not as a failure to read', async () => {
    fake = await boot();
    connect(fake, baselineSnapshot(fake));

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.kind === 'anon_readable')).toBe(false);
    // The probe really did use the anon key.
    expect(fake.requests.some((r) => r.key === 'anon')).toBe(true);
  });

  it('skips both anon probes entirely when no anon key is connected', async () => {
    fake = await boot();
    store.config = { supabaseUrl: fake.url, serviceKey: fake.state.serviceKey, anonKey: null, snapshot: baselineSnapshot(fake) };

    await runCanaryCheck(PROJECT);
    expect(fake.requests.some((r) => r.key === 'anon')).toBe(false);
  });
});

describe('runCanaryCheck — anonymous WRITE access', () => {
  it('reports a decoy table the anon role could insert into, which the read probe calls protected', async () => {
    fake = await boot({ anonCanInsert: true });
    connect(fake, baselineSnapshot(fake));

    const summary = await runCanaryCheck(PROJECT);
    const detection = summary.detections.find((d) => d.detail.includes('INSERT'));
    expect(detection?.kind).toBe('anon_readable');
    // The probe is non-destructive: it relies on a constraint rejecting the row.
    expect(detection?.detail).toMatch(/No row was created/i);
  });

  it('says nothing when the policy refuses the write', async () => {
    fake = await boot();
    connect(fake, baselineSnapshot(fake));

    const summary = await runCanaryCheck(PROJECT);
    expect(summary.detections.some((d) => d.detail.includes('INSERT'))).toBe(false);
    // It really did try, with the anon key.
    expect(fake.requests.some((r) => r.method === 'POST' && r.key === 'anon')).toBe(true);
  });
});

describe('runCanaryCheck — alert suppression', () => {
  it('records a standing condition once, not on every run', async () => {
    fake = await boot();
    const snapshot = baselineSnapshot(fake);
    fake.state.canaryRows = fake.state.canaryRows.map((r) =>
      r.marker === MARKERS[0] ? { ...r, payload: { note: 'tampered' } } : r,
    );
    connect(fake, snapshot);

    const first = await runCanaryCheck(PROJECT);
    expect(first.detections).toHaveLength(1);
    expect(store.events).toHaveLength(1);

    // Same condition, same snapshot: the event is already on record.
    connect(fake, snapshot);
    const second = await runCanaryCheck(PROJECT);
    expect(second.detections).toEqual([]);
    expect(second.suppressed).toBe(1);
    expect(store.events).toHaveLength(1);
  });

  it('keeps a genuinely new detection in a batch that also repeats an old one', async () => {
    fake = await boot();
    const snapshot = baselineSnapshot(fake);
    fake.state.canaryRows = fake.state.canaryRows.map((r) =>
      r.marker === MARKERS[0] ? { ...r, payload: { note: 'tampered' } } : r,
    );
    connect(fake, snapshot);
    await runCanaryCheck(PROJECT);

    // A second row is now tampered with as well.
    fake.state.canaryRows = fake.state.canaryRows.map((r) =>
      r.marker === MARKERS[1] ? { ...r, payload: { note: 'tampered too' } } : r,
    );
    connect(fake, snapshot);

    const second = await runCanaryCheck(PROJECT);
    expect(second.detections).toHaveLength(1);
    expect(second.detections[0]?.marker).toBe(MARKERS[1]);
    expect(second.suppressed).toBe(1);
  });
});

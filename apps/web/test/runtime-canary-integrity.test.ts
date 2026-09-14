import { describe, expect, it, vi } from 'vitest';

import { evaluateIntegrity, sha256Canonical, type SnapshotMirror, type TriggerLogRow } from '@/lib/runtime/canaries/integrity';
import { evaluateAnonProbe, evaluateAnonWriteProbe } from '@/lib/runtime/canaries/rls-probe';
import { buildSetupScript } from '@/lib/runtime/canaries/setup-script';
import { restSelect, validateAnonKey, validateServiceKey } from '@/lib/runtime/canaries/supabase-rest';
import { MAX_LOG_ROWS_PER_CHECK } from '@/lib/runtime/canaries/types';

const ROWS = [
  { marker: 'CANARY::abc::A', payload: { note: 'x' } },
  { marker: 'CANARY::abc::B', payload: { note: 'y' } },
  { marker: 'CANARY::abc::C', payload: { note: 'z' } },
];

function snapshotOf(over: Partial<SnapshotMirror> = {}): SnapshotMirror {
  return {
    payloadHashes: Object.fromEntries(ROWS.map((r) => [r.marker, sha256Canonical(r.payload)])),
    logRowCount: 5,
    lastLogId: 10,
    takenAt: new Date().toISOString(),
    ...over,
  };
}

const logRow = (over: Partial<TriggerLogRow> = {}): TriggerLogRow => ({
  id: 11,
  canary_marker: 'CANARY::abc::A',
  action: 'UPDATE',
  acted_at: '2026-09-15T14:00:00Z',
  ...over,
});

const kinds = (r: { detections: Array<{ kind: string }> }) => r.detections.map((d) => d.kind);

describe('evaluateIntegrity — baseline', () => {
  it('reports nothing on the very first check and records the hashes', () => {
    const r = evaluateIntegrity({ snapshot: null, liveRows: ROWS, liveLogCount: 5 });
    expect(r.detections).toHaveLength(0);
    expect(Object.keys(r.newSnapshot.payloadHashes)).toHaveLength(3);
  });

  it('starts the log watermark at what already exists, so history is not replayed as intrusions', () => {
    const r = evaluateIntegrity({
      snapshot: null,
      liveRows: ROWS,
      liveLogCount: 40,
      newLogRows: [logRow({ id: 38 }), logRow({ id: 40 })],
    });
    expect(r.detections).toHaveLength(0);
    expect(r.newSnapshot.lastLogId).toBe(40);
  });

  it('still compares payloads on a snapshot written before watermarks existed', () => {
    // Treating a missing watermark as "no snapshot at all" would rebaseline a
    // row an intruder had already modified, losing the detection permanently.
    const legacy = snapshotOf();
    delete legacy.lastLogId;
    const tampered = [...ROWS];
    tampered[1] = { ...tampered[1]!, payload: { note: 'ATTACKER EDIT' } };

    const r = evaluateIntegrity({ snapshot: legacy, liveRows: tampered, liveLogCount: 5 });
    expect(kinds(r)).toContain('modified');
  });

  it('does not report log rows until a watermark exists to measure them against', () => {
    const legacy = snapshotOf();
    delete legacy.lastLogId;
    const r = evaluateIntegrity({ snapshot: legacy, liveRows: ROWS, liveLogCount: 5, newLogRows: [logRow()] });
    expect(r.detections.filter((d) => d.source === 'trigger_log')).toHaveLength(0);
    expect(r.newSnapshot.lastLogId).toBe(11);
  });
});

describe('evaluateIntegrity — state', () => {
  it('reports nothing when every row is intact', () => {
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: 5 });
    expect(r.detections).toHaveLength(0);
    expect(Object.values(r.verdicts).every((v) => v === 'ok')).toBe(true);
  });

  it('reports a deleted row and marks it missing', () => {
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS.slice(0, 2), liveLogCount: 5 });
    expect(r.detections).toContainEqual(expect.objectContaining({ kind: 'deleted', marker: 'CANARY::abc::C' }));
    expect(r.verdicts['CANARY::abc::C']).toBe('missing');
  });

  it('reports a modified payload and carries the marker as a field, not buried in prose', () => {
    const tampered = [...ROWS];
    tampered[1] = { ...tampered[1]!, payload: { note: 'ATTACKER EDIT' } };
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: tampered, liveLogCount: 5 });

    const detection = r.detections.find((d) => d.kind === 'modified');
    expect(detection?.marker).toBe('CANARY::abc::B');
    expect(detection?.source).toBe('integrity');
  });

  it('hashes payloads independently of key order, so a reordered object is not a breach', () => {
    // JSON.stringify follows insertion order; a hash that depended on it would
    // send a false "you have been breached" the day anything upstream reorders.
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(sha256Canonical({ b: 2, a: 1 }));
    expect(sha256Canonical({ a: { x: 1, y: 2 } })).toBe(sha256Canonical({ a: { y: 2, x: 1 } }));
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
    expect(sha256Canonical([1, 2])).not.toBe(sha256Canonical([2, 1]));
  });

  it('uses the supplied roster, so a marker the snapshot forgot is still looked for', () => {
    const snapshot = snapshotOf();
    delete snapshot.payloadHashes['CANARY::abc::C'];
    const r = evaluateIntegrity({
      snapshot,
      liveRows: ROWS.slice(0, 2),
      liveLogCount: 5,
      expectedMarkers: ROWS.map((x) => x.marker),
    });
    expect(r.detections).toContainEqual(expect.objectContaining({ kind: 'deleted', marker: 'CANARY::abc::C' }));
  });
});

describe('evaluateIntegrity — the trigger log', () => {
  it('reports every new log row as an intrusion, with the operation and the time', () => {
    const r = evaluateIntegrity({
      snapshot: snapshotOf(),
      liveRows: ROWS,
      liveLogCount: 7,
      newLogRows: [logRow({ id: 11, action: 'UPDATE' }), logRow({ id: 12, action: 'DELETE' })],
    });

    expect(kinds(r)).toEqual(['modified', 'deleted']);
    expect(r.detections[0]?.occurredAt).toBe('2026-09-15T14:00:00Z');
    expect(r.detections[0]?.source).toBe('trigger_log');
    expect(r.newSnapshot.lastLogId).toBe(12);
  });

  it('catches a modify-then-restore that leaves the current state identical', () => {
    // This is the evasion the old code could not see: the payload hash matches,
    // the row count went UP not down, and growth was explicitly treated as fine.
    const r = evaluateIntegrity({
      snapshot: snapshotOf(),
      liveRows: ROWS,
      liveLogCount: 7,
      newLogRows: [logRow({ id: 11 }), logRow({ id: 12 })],
    });
    expect(r.detections).toHaveLength(2);
  });

  it('does not report the same log row twice once the watermark has passed it', () => {
    const r = evaluateIntegrity({ snapshot: snapshotOf({ lastLogId: 12 }), liveRows: ROWS, liveLogCount: 7, newLogRows: [] });
    expect(r.detections).toHaveLength(0);
    expect(r.newSnapshot.lastLogId).toBe(12);
  });

  it('caps how many it lists and states the overflow rather than dropping it', () => {
    const many = Array.from({ length: MAX_LOG_ROWS_PER_CHECK + 15 }, (_, i) => logRow({ id: 11 + i }));
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: 99, newLogRows: many });

    expect(r.detections.length).toBe(MAX_LOG_ROWS_PER_CHECK + 1);
    expect(r.detections.at(-1)?.detail).toContain('15 further decoy-row writes');
  });

  it('does not double-report a marker the log already accounted for', () => {
    const r = evaluateIntegrity({
      snapshot: snapshotOf(),
      liveRows: ROWS.slice(0, 2),
      liveLogCount: 6,
      newLogRows: [logRow({ id: 11, action: 'DELETE', canary_marker: 'CANARY::abc::C' })],
    });
    expect(r.detections.filter((d) => d.marker === 'CANARY::abc::C')).toHaveLength(1);
    expect(r.detections[0]?.source).toBe('trigger_log');
  });

  it('ignores the self-test row entirely — we wrote it', () => {
    const r = evaluateIntegrity({
      snapshot: snapshotOf(),
      liveRows: [...ROWS, { marker: 'CANARY::abc::SELFTEST', payload: { nonce: 'fresh' } }],
      liveLogCount: 6,
      newLogRows: [logRow({ id: 11, canary_marker: 'CANARY::abc::SELFTEST' })],
      selfTestMarker: 'CANARY::abc::SELFTEST',
    });
    expect(r.detections).toHaveLength(0);
    // Its rotating payload never enters the baseline either.
    expect(r.newSnapshot.payloadHashes['CANARY::abc::SELFTEST']).toBeUndefined();
    // But the watermark still advances past its entry.
    expect(r.newSnapshot.lastLogId).toBe(11);
  });

  it('reports a log that shrank', () => {
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: 0 });
    expect(kinds(r)).toContain('log_wiped');
  });

  it('does not accuse anyone of a cover-up when a restore explains it just as well', () => {
    // A point-in-time restore lowers the count exactly the way a deletion does.
    // Naming a cause we cannot establish is the one false accusation this
    // product cannot take back.
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: 2, liveMaxLogId: 12 });
    const wiped = r.detections.find((d) => d.kind === 'log_wiped');
    expect(wiped?.detail).toMatch(/either a restore ran, or someone removed the record/i);
    expect(wiped?.detail).toMatch(/3 entries are gone/i);
  });

  it('tells a deleted-from log apart from one that was recreated', () => {
    // Identity ids are never reused, so a highest id BELOW one already seen
    // means the table itself is new — dropped, truncated, or restored.
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: 1, liveMaxLogId: 1 });
    const wiped = r.detections.find((d) => d.kind === 'log_wiped');
    expect(wiped?.detail).toMatch(/dropped and recreated, truncated, or restored/i);
    expect(wiped?.detail).toContain('from 10 to 1');
  });

  it('falls back to the plain wording when the highest id could not be read', () => {
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: 1, liveMaxLogId: null });
    expect(r.detections.find((d) => d.kind === 'log_wiped')?.detail).toMatch(/id sequence kept climbing/i);
  });

  it('singularises a single missing entry', () => {
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: 4, liveMaxLogId: 12 });
    expect(r.detections.find((d) => d.kind === 'log_wiped')?.detail).toMatch(/1 entry is gone/i);
  });

  it('reports a row that appeared in the decoy table as an injection, not a modification', () => {
    // Only the setup script inserts into that table, and it disarms the trigger
    // while it does — so an INSERT in the log came from something else.
    const r = evaluateIntegrity({
      snapshot: snapshotOf(),
      liveRows: [...ROWS, { marker: 'not-ours', payload: {} }],
      liveLogCount: 6,
      newLogRows: [logRow({ id: 11, action: 'INSERT', canary_marker: 'not-ours' })],
    });
    const added = r.detections.find((d) => d.kind === 'row_added');
    expect(added).toBeTruthy();
    expect(added?.source).toBe('trigger_log');
    expect(added?.marker).toBe('not-ours');
    expect(added?.detail).toMatch(/was inserted into the decoy table/i);
    expect(added?.occurredAt).toBe('2026-09-15T14:00:00Z');
    // It is an injection, not an edit of one of our rows.
    expect(kinds(r)).not.toContain('modified');
  });

  it('still treats an operation it does not recognise as a write', () => {
    const r = evaluateIntegrity({
      snapshot: snapshotOf(),
      liveRows: ROWS,
      liveLogCount: 6,
      newLogRows: [logRow({ id: 11, action: 'TRUNCATE' })],
    });
    expect(kinds(r)).toContain('modified');
  });

  it('cannot judge the log when it could not be counted', () => {
    const r = evaluateIntegrity({ snapshot: snapshotOf(), liveRows: ROWS, liveLogCount: null });
    expect(kinds(r)).not.toContain('log_wiped');
    expect(r.newSnapshot.logRowCount).toBe(5);
  });
});

describe('anon probes', () => {
  it('reads rows through the anon key as an RLS hole', () => {
    expect(evaluateAnonProbe({ status: 200, rowCount: 3 })).toMatchObject({ kind: 'anon_readable' });
  });

  it('treats an empty 200, a 401, a 403 and a network failure as no alarm', () => {
    // PostgREST answers a filtered-out query with 200 and an empty array, so an
    // empty 200 is the healthy result rather than a failure to read.
    expect(evaluateAnonProbe({ status: 200, rowCount: 0 })).toBeNull();
    expect(evaluateAnonProbe({ status: 401, rowCount: null })).toBeNull();
    expect(evaluateAnonProbe({ status: 403, rowCount: null })).toBeNull();
    expect(evaluateAnonProbe({ status: 0, rowCount: null })).toBeNull();
  });

  it('reports a table the anon role could write to, which the read probe calls protected', () => {
    expect(evaluateAnonWriteProbe({ wouldWrite: true })).toMatchObject({ kind: 'anon_readable' });
    expect(evaluateAnonWriteProbe({ wouldWrite: true })?.detail).toContain('INSERT');
    expect(evaluateAnonWriteProbe({ wouldWrite: false })).toBeNull();
  });
});

describe('buildSetupScript', () => {
  const s = buildSetupScript({ projectId: '12345678-abcd-1234-abcd-1234567890ab', appDomain: 'app.scanlyfix.dev' });

  it('plants three decoys plus a self-test row, all with distinct markers', () => {
    expect(s.seeds).toHaveLength(3);
    expect(new Set([...s.seeds, s.selfTest].map((x) => x.marker)).size).toBe(4);
    expect(s.selfTest.marker).toContain('SELFTEST');
  });

  it('enables row level security, installs the watch trigger, and embeds honeytoken URLs', () => {
    expect(s.sql).toContain('enable row level security');
    expect(s.sql).toContain('after insert or update or delete');
    expect(s.sql).toContain('/api/runtime/honeytoken/');
    expect(s.sql).toContain('security definer');
    expect(s.sql).toContain('set search_path = public');
  });

  it('arms the trigger only after planting, so the script never logs its own work', () => {
    // The trigger watches INSERT, so creating it before the seed rows go in
    // would record four intrusions on setup night.
    const drop = s.sql.indexOf('drop trigger if exists');
    const insert = s.sql.indexOf('insert into public.scanlyfix_canaries (marker, payload) values');
    const create = s.sql.indexOf('create trigger');
    expect(drop).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(drop);
    expect(create).toBeGreaterThan(insert);
  });

  it('branches on tg_op, because OLD does not exist during an INSERT', () => {
    // Reading old.marker in an INSERT trigger raises "record old is not
    // assigned yet" and aborts the customer's own statement — the one thing an
    // observe-only trigger must never do.
    expect(s.sql).toContain("if tg_op = 'INSERT' then");
    expect(s.sql).toContain('values (new.marker, tg_op, null)');
    expect(s.sql).toContain('values (old.marker, tg_op, to_jsonb(old))');
  });

  it('clears the previous generation while the trigger is disarmed', () => {
    const del = s.sql.indexOf('delete from public.scanlyfix_canaries');
    const drop = s.sql.indexOf('drop trigger if exists');
    const create = s.sql.indexOf('create trigger');
    expect(del).toBeGreaterThan(drop);
    expect(del).toBeLessThan(create);
    // Only this project's own markers, and never the ones being planted now.
    expect(s.sql).toContain("where marker like 'CANARY::");
    for (const seed of [...s.seeds, s.selfTest]) {
      expect(s.sql.slice(del, s.sql.indexOf('insert into public.scanlyfix_canaries'))).toContain(seed.marker);
    }
  });

  it('inserts every row it registered, self-test included', () => {
    for (const seed of [...s.seeds, s.selfTest]) expect(s.sql).toContain(seed.marker);
  });

  it('is written in English, because the customer pastes it into their own console', () => {
    for (const hinglish of ['gayab', 'badla', 'zaroori', 'nahi', 'karo', 'wala', 'rehta']) {
      expect(s.sql.toLowerCase(), hinglish).not.toContain(hinglish);
    }
  });

  it('emits each row as a well-formed, single-quoted literal pair', () => {
    // Payloads are generated rather than user input, but this is SQL a customer
    // pastes into their own console, so its shape is pinned.
    const valuesBlock = s.sql.slice(s.sql.indexOf('(marker, payload) values'));
    const rowLines = valuesBlock.split('\n').filter((l) => l.trim().startsWith("('"));
    expect(rowLines).toHaveLength(4);
    for (const line of rowLines) {
      expect(line.trim()).toMatch(/^\('CANARY::[^']+', '\{.*\}'::jsonb\),?$/);
    }
  });

  it('doubles a quote inside a payload instead of ending the literal', () => {
    // The escaping rule itself, exercised through the one value that is not
    // fixed: the app domain lands inside the JSON payload.
    const withQuote = buildSetupScript({ projectId: 'p', appDomain: "ap'p.test" });
    expect(withQuote.sql).toContain("ap''p.test");
    expect(withQuote.sql).not.toContain("ap'p.test'");
  });
});

describe('key validation', () => {
  const makeJwt = (payload: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${p}.dummy_signature`;
  };

  it('rejects an anon key in the service-key field and says which key is needed', () => {
    const result = validateServiceKey(makeJwt({ role: 'anon', iss: 'supabase' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/service role key/i);
      expect(result.error).toMatch(/row level security/i);
    }
  });

  it('accepts both service key formats', () => {
    expect(validateServiceKey('sb_secret_prod_abc1234567890')).toEqual({ valid: true });
    expect(validateServiceKey(makeJwt({ role: 'service_role', iss: 'supabase' }))).toEqual({ valid: true });
  });

  it('rejects anything it cannot recognise', () => {
    expect(validateServiceKey('not-a-jwt').valid).toBe(false);
    expect(validateServiceKey(makeJwt({ role: 'authenticated' })).valid).toBe(false);
    expect(validateServiceKey('').valid).toBe(false);
  });

  it('rejects a service key in the ANON field, which would fake an RLS breach', () => {
    // A service key bypasses row level security, so the read probe would see
    // every decoy row and report a public-exposure breach on a secure database.
    const asService = validateAnonKey(makeJwt({ role: 'service_role' }));
    expect(asService.valid).toBe(false);
    if (!asService.valid) expect(asService.error).toMatch(/bypasses row level security/i);

    const asSecret = validateAnonKey('sb_secret_prod_abc');
    expect(asSecret.valid).toBe(false);
    if (!asSecret.valid) expect(asSecret.error).toMatch(/secret key/i);
  });

  it('accepts a genuine anon or publishable key', () => {
    expect(validateAnonKey(makeJwt({ role: 'anon' }))).toEqual({ valid: true });
    expect(validateAnonKey('sb_publishable_abc123')).toEqual({ valid: true });
    expect(validateAnonKey('').valid).toBe(false);
  });
});

describe('restSelect — transient retry behaviour', () => {
  it('retries a schema-cache reload and succeeds on the next attempt', async () => {
    let callCount = 0;
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ code: 'PGRST002', message: 'Could not query the database for the schema cache.' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([{ marker: 'CANARY::test::A', payload: { note: 'ok' } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await restSelect({ url: 'https://test.supabase.co', serviceKey: 'test-key' }, 'scanlyfix_canaries', {
        retries: 2,
        retryDelayMs: 1,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });
});

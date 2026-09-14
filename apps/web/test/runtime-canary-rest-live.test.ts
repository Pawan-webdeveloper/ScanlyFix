/**
 * The PostgREST client, against a real socket.
 *
 * Every other canary test mocks `restSelect`, so nothing has ever checked the
 * things that function is actually responsible for: how it builds the URL and
 * query string, which key it sends in which header, how it reads a count out of
 * `Content-Range`, whether HEAD really sends no body, and whether the retry
 * path recovers from the transient errors Supabase returns when a project is
 * waking up. All of that is HTTP, and a mock of the HTTP function cannot see it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  listTableNames,
  restHeadCount,
  restSelect,
  type RestConfig,
} from '../lib/runtime/canaries/supabase-rest.ts';
import { CANARY_LOG_TABLE, CANARY_TABLE } from '../lib/runtime/canaries/types.ts';
import { recordTrigger, startFakeSupabase, type FakeSupabase } from './support/fake-supabase.ts';

let fake: FakeSupabase | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

function config(f: FakeSupabase): RestConfig {
  return { url: f.url, serviceKey: f.state.serviceKey, anonKey: f.state.anonKey };
}

describe('restSelect — request construction', () => {
  it('sends the service key in both apikey and authorization by default', async () => {
    fake = await startFakeSupabase();
    const res = await restSelect<{ marker: string }>(config(fake), CANARY_TABLE, { query: 'select=marker,payload' });

    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(3);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', key: 'service' });
    expect(fake.requests[0]?.path).toBe('/rest/v1/scanlyfix_canaries?select=marker,payload');
  });

  it('uses the anon key when asked, and gets what an anonymous caller would get', async () => {
    fake = await startFakeSupabase();
    const res = await restSelect(config(fake), CANARY_TABLE, { key: 'anon', limit: 1 });

    expect(fake.requests[0]?.key).toBe('anon');
    // RLS is on with no policy: PostgREST answers 200 with an empty set, not 403.
    // The RLS probe is built on exactly that distinction.
    expect(res.status).toBe(200);
    expect(res.data).toEqual([]);
  });

  it('sees rows through the anon key only when RLS is actually broken', async () => {
    fake = await startFakeSupabase({ anonReadable: { [CANARY_TABLE]: 3 } });
    const res = await restSelect(config(fake), CANARY_TABLE, { key: 'anon', limit: 1 });

    expect(res.status).toBe(200);
    expect(res.data?.length).toBe(1); // limit applied
  });

  it('combines a query and a limit into one query string', async () => {
    fake = await startFakeSupabase();
    await restSelect(config(fake), CANARY_TABLE, { query: 'select=marker', limit: 2 });
    expect(fake.requests[0]?.path).toBe('/rest/v1/scanlyfix_canaries?select=marker&limit=2');
  });

  it('reads the row count out of Content-Range when count is requested', async () => {
    fake = await startFakeSupabase();
    for (let i = 0; i < 7; i++) {
      recordTrigger(fake.state, { marker: 'CANARY::proj1234::A', action: 'UPDATE', oldPayload: {}, actedAt: '2026-09-15T00:00:00Z' });
    }

    const res = await restSelect<{ id: number }>(config(fake), CANARY_LOG_TABLE, { query: 'select=id', withCount: true });
    expect(fake.requests[0]?.prefer).toBe('count=exact');
    expect(res.count).toBe(7);
  });

  it('reports a count of zero rather than null on an empty table', async () => {
    fake = await startFakeSupabase();
    const res = await restSelect(config(fake), CANARY_LOG_TABLE, { query: 'select=id', withCount: true });
    // "no rows" and "could not read" must not look the same to the caller.
    expect(res.count).toBe(0);
    expect(res.ok).toBe(true);
  });
});

describe('restSelect — failure handling', () => {
  it('reports a missing relation as 404 without throwing', async () => {
    fake = await startFakeSupabase({ canaryTableExists: false });
    const res = await restSelect(config(fake), CANARY_TABLE, { query: 'select=marker' });

    expect(res.status).toBe(404);
    expect(res.ok).toBe(false);
    expect(res.data).toBeNull();
  });

  it('reports a rejected key as 401 without throwing', async () => {
    fake = await startFakeSupabase();
    const res = await restSelect({ url: fake.url, serviceKey: 'wrong-key' }, CANARY_TABLE, {});

    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
  });

  it('retries a waking-up project and succeeds on a later attempt', async () => {
    // Supabase answers 503 with PGRST002 while the schema cache reloads. Failing
    // the nightly check for that would be a false "unreachable" every cold start.
    fake = await startFakeSupabase({
      failWith: { status: 503, body: JSON.stringify({ code: 'PGRST002', message: 'schema cache reloading' }), times: 2 },
    });

    const res = await restSelect<{ marker: string }>(config(fake), CANARY_TABLE, { query: 'select=marker', retryDelayMs: 1 });

    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(3);
    expect(fake.requests).toHaveLength(3); // two failures, then success
  });

  it('gives up after the retry budget and reports the last status', async () => {
    fake = await startFakeSupabase({ failWith: { status: 503, body: '{"code":"PGRST002"}', times: 99 } });
    const res = await restSelect(config(fake), CANARY_TABLE, { query: 'select=marker', retryDelayMs: 1 });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(fake.requests).toHaveLength(3);
  });

  it('does not retry a permanent error', async () => {
    fake = await startFakeSupabase({ failWith: { status: 404, body: '{"code":"42P01"}', times: 99 } });
    await restSelect(config(fake), CANARY_TABLE, { query: 'select=marker', retryDelayMs: 1 });
    // Retrying a missing table just delays the answer.
    expect(fake.requests).toHaveLength(1);
  });

  it('returns status 0 for a connection that never lands', async () => {
    const res = await restSelect({ url: 'http://127.0.0.1:1', serviceKey: 'k' }, CANARY_TABLE, { retryDelayMs: 1 });
    expect(res.status).toBe(0);
    expect(res.ok).toBe(false);
  });
});

describe('restHeadCount — the anon-access audit probe', () => {
  it('uses HEAD, asks for an exact count, and never receives a body', async () => {
    fake = await startFakeSupabase({ anonReadable: { public_posts: 12 } });
    const res = await restHeadCount(config(fake), 'public_posts');

    expect(res.status).toBe(200);
    expect(res.count).toBe(12);
    expect(fake.requests[0]).toMatchObject({ method: 'HEAD', key: 'anon', prefer: 'count=exact' });
  });

  it('reports zero for a table RLS protects, which is not the same as unreachable', async () => {
    fake = await startFakeSupabase();
    const res = await restHeadCount(config(fake), 'users');
    expect(res.status).toBe(200);
    expect(res.count).toBe(0);
  });

  it('reports a null count when the table cannot be read at all', async () => {
    fake = await startFakeSupabase();
    const res = await restHeadCount(config(fake), 'no_such_table');
    expect(res.status).toBe(404);
    expect(res.count).toBeNull();
  });

  it('never throws on a dead host', async () => {
    const res = await restHeadCount({ url: 'http://127.0.0.1:1', serviceKey: 'k', anonKey: 'a' }, 'users');
    expect(res).toEqual({ status: 0, count: null });
  });
});

describe('listTableNames — reading the schema', () => {
  it('returns the tables the OpenAPI spec advertises', async () => {
    fake = await startFakeSupabase();
    const tables = await listTableNames(config(fake));
    expect(tables).toEqual(['scanlyfix_canaries', 'scanlyfix_canary_log', 'users', 'orders', 'public_posts']);
    expect(fake.requests[0]?.key).toBe('service');
  });

  it('returns null rather than an empty list when the schema cannot be read', async () => {
    fake = await startFakeSupabase({ failWith: { status: 401, times: 99 } });
    // null and [] must stay distinct: "no tables" would silently pass an audit.
    expect(await listTableNames(config(fake))).toBeNull();
  });

  it('returns null on a dead host', async () => {
    expect(await listTableNames({ url: 'http://127.0.0.1:1', serviceKey: 'k' })).toBeNull();
  });
});

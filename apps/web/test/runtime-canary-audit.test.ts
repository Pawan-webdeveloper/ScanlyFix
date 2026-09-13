import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const getCanaryProjectConfigMock = vi.fn();
vi.mock('@scanlyfix/db', () => ({
  getCanaryProjectConfig: (...args: unknown[]) => getCanaryProjectConfigMock(...args),
}));

vi.mock('@/lib/header-encryption', () => ({
  decryptValue: vi.fn((v: string) => `decrypted_${v}`),
}));

import { restHeadCount } from '@/lib/runtime/canaries/supabase-rest';
import { runAnonAccessAudit } from '@/lib/runtime/canaries/engine';

describe('restHeadCount — true zero-body count probe (TASK 5)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses HTTP HEAD, passes prefer count=exact, reads count from Content-Range, zero body reads', async () => {
    const jsonSpy = vi.fn();
    const textSpy = vi.fn();

    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-range': '0-0/42',
      }),
      json: jsonSpy,
      text: textSpy,
      body: null,
    });
    global.fetch = fetchMock;

    const res = await restHeadCount(
      { url: 'https://test-ref.supabase.co', serviceKey: 'srv_key', anonKey: 'anon_key' },
      'user_profiles',
    );

    // 1. Must use method HEAD
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test-ref.supabase.co/rest/v1/user_profiles');
    expect(init.method).toBe('HEAD');

    // 2. Must request count=exact header
    const headers = init.headers as Record<string, string>;
    expect(headers.prefer).toBe('count=exact');
    expect(headers.apikey).toBe('anon_key');

    // 3. Count parsed from Content-Range
    expect(res).toEqual({ status: 200, count: 42 });

    // 4. ZERO body reads — neither res.json nor res.text may ever be called
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('returns status and count=0 when content-range reports 0 rows', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({
        'content-range': '*/0',
      }),
    });

    const res = await restHeadCount(
      { url: 'https://test-ref.supabase.co', serviceKey: 'srv_key', anonKey: 'anon_key' },
      'empty_table',
    );

    expect(res).toEqual({ status: 200, count: 0 });
  });

  it('returns count=null on non-200 (401/403/404)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 401,
      headers: new Headers(),
    });

    const res = await restHeadCount(
      { url: 'https://test-ref.supabase.co', serviceKey: 'srv_key', anonKey: 'anon_key' },
      'protected_table',
    );

    expect(res).toEqual({ status: 401, count: null });
  });
});

describe('runAnonAccessAudit — batching & zero-body probes across tables (TASK 5)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('audits user tables strictly using HEAD in chunks of 8 with zero body reads', async () => {
    getCanaryProjectConfigMock.mockResolvedValue({
      projectId: 'proj_audit_1',
      supabaseUrl: 'https://test-ref.supabase.co',
      serviceKey: 'srv_key',
      anonKey: 'anon_key',
    });

    // 10 tables to audit (to verify chunking of 8 + 2)
    const tableNames = Array.from({ length: 10 }, (_, i) => `table_${i + 1}`);

    const calledMethods: string[] = [];
    const calledUrls: string[] = [];
    const bodyReadSpies: Mock[] = [];

    global.fetch = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calledUrls.push(u);
      calledMethods.push(init?.method ?? 'GET');

      if (u.endsWith('/rest/v1/')) {
        // Schema definition fetch
        return {
          ok: true,
          status: 200,
          json: async () => ({
            definitions: Object.fromEntries(
              [...tableNames, 'scanlyfix_canaries', 'scanlyfix_canary_log'].map((t) => [t, {}]),
            ),
          }),
        };
      }

      // Per-table probe
      const bodySpy = vi.fn();
      bodyReadSpies.push(bodySpy);

      // table_1 is readable (count 5), table_2 is protected (count 0), others protected
      const tableName = u.split('/rest/v1/')[1]!;
      const count = tableName === 'table_1' ? '5' : '0';

      return {
        status: 200,
        headers: new Headers({
          'content-range': `0-0/${count}`,
        }),
        json: bodySpy,
        text: bodySpy,
      };
    });

    const report = await runAnonAccessAudit('proj_audit_1');

    expect(report).not.toBeNull();
    expect(report?.readable).toEqual(['table_1']);
    expect(report?.protectedCount).toBe(9);

    // Filter per-table calls (excluding the OpenAPI schema read)
    const tableCalls = calledMethods.filter((_m, idx) => !calledUrls[idx]!.endsWith('/rest/v1/'));
    expect(tableCalls).toHaveLength(10);

    // ASSERTION: ALL user table audit probes MUST use HEAD (zero GETs on user tables)
    expect(tableCalls.every((method) => method === 'HEAD')).toBe(true);

    // ASSERTION: ZERO body reads across all user table probes
    expect(bodyReadSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});

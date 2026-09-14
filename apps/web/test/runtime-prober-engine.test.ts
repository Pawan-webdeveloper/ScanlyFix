import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProbeEvidence } from '../lib/runtime/auth-prober/types.ts';

const getRuntimeProjectContextMock = vi.fn();
const listProberTargetsMock = vi.fn();
const seedProberTargetsMock = vi.fn();
const setBaselineMock = vi.fn();
const recordCheckMock = vi.fn();
const findUnresolvedFindingMock = vi.fn();
const insertFindingMock = vi.fn();
const touchFindingMock = vi.fn();
const autoResolveFindingMock = vi.fn();
const listFindingsMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  getRuntimeProjectContext: (...args: unknown[]) => getRuntimeProjectContextMock(...args),
  listProberTargets: (...args: unknown[]) => listProberTargetsMock(...args),
  seedProberTargets: (...args: unknown[]) => seedProberTargetsMock(...args),
  setBaseline: (...args: unknown[]) => setBaselineMock(...args),
  recordCheck: (...args: unknown[]) => recordCheckMock(...args),
  findUnresolvedFinding: (...args: unknown[]) => findUnresolvedFindingMock(...args),
  insertFinding: (...args: unknown[]) => insertFindingMock(...args),
  touchFinding: (...args: unknown[]) => touchFindingMock(...args),
  autoResolveFinding: (...args: unknown[]) => autoResolveFindingMock(...args),
  listFindings: (...args: unknown[]) => listFindingsMock(...args),
}));

const probeTargetMock = vi.fn();
const probeTargetWithAnonKeyMock = vi.fn();
const fetchHomeFingerprintMock = vi.fn();
vi.mock('../lib/runtime/auth-prober/probe.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/runtime/auth-prober/probe.ts')>();
  return {
    ...actual,
    probeTarget: (...args: unknown[]) => probeTargetMock(...args),
    probeTargetWithAnonKey: (...args: unknown[]) => probeTargetWithAnonKeyMock(...args),
    fetchHomeFingerprint: (...args: unknown[]) => fetchHomeFingerprintMock(...args),
  };
});

const getOrRefreshProjectAnonKeyMock = vi.fn();
vi.mock('../lib/runtime/auth-prober/anon-key.ts', () => ({
  getOrRefreshProjectAnonKey: (...args: unknown[]) => getOrRefreshProjectAnonKeyMock(...args),
}));

import { runAuthProber } from '../lib/runtime/auth-prober/engine.ts';

const VERIFIED = { id: 'proj_1', hostname: 'example.com', isVerified: true };

function evidence(partial: Partial<ProbeEvidence>): ProbeEvidence {
  return {
    contentType: 'text/html',
    bodyBytes: 1200,
    bodySample: 'Admin console Users Settings',
    bodyHash: 'aaaaaaaaaaaaaaaa',
    location: null,
    wwwAuthenticate: null,
    bodyKind: 'html_app',
    title: 'Admin',
    ...partial,
  };
}

/** Keyed dedupe mock: `open` maps "path|variant" → existing finding. */
function openFindings(map: Record<string, { id: string }>) {
  findUnresolvedFindingMock.mockImplementation((_p: string, path: string, _m: string, variant: string | null) =>
    Promise.resolve(map[`${path}|${variant ?? 'null'}`] ?? null),
  );
}

describe('runtime auth prober — engine execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrRefreshProjectAnonKeyMock.mockResolvedValue(null);
    fetchHomeFingerprintMock.mockResolvedValue(null);
    listFindingsMock.mockResolvedValue([]);
    openFindings({});
    insertFindingMock.mockImplementation((input: Record<string, unknown>) => Promise.resolve({ id: 'f_new', ...input }));
  });

  it('skips run if project does not exist or has no hostname', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(null);
    const summary = await runAuthProber('proj_missing');
    expect(summary.checked).toBe(0);
    expect(listProberTargetsMock).not.toHaveBeenCalled();
  });

  it('skips run if domain is unverified to prevent abuse', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({ ...VERIFIED, isVerified: false });
    const summary = await runAuthProber('proj_1');
    expect(summary.checked).toBe(0);
    expect(listProberTargetsMock).not.toHaveBeenCalled();
    expect(fetchHomeFingerprintMock).not.toHaveBeenCalled();
  });

  it('seeds default targets if no targets exist initially', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
    listProberTargetsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 't_1', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: null }]);
    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 401 });

    const summary = await runAuthProber('proj_1');
    expect(seedProberTargetsMock).toHaveBeenCalledTimes(1);
    const seeded = seedProberTargetsMock.mock.calls[0]![1] as Array<{ path: string; source: string }>;
    expect(seeded.length).toBeGreaterThan(16);
    expect(seeded.every((t) => t.source === 'default')).toBe(true);
    expect(setBaselineMock).toHaveBeenCalledWith('t_1', 401, expect.objectContaining({ verdict: 'baseline_recorded' }));
    expect(summary.baselinesRecorded).toBe(1);
  });

  it('records initial baseline on first probe without raising findings (legacy status-only outcome)', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
    listProberTargetsMock.mockResolvedValueOnce([{ id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: null }]);
    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 403 });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });
    expect(setBaselineMock).toHaveBeenCalledWith('t_admin', 403, expect.anything());
    expect(summary.baselinesRecorded).toBe(1);
    expect(summary.newFindings).toBe(0);
    expect(onNewFindings).not.toHaveBeenCalled();
  });

  it('detects regression (protected → 200 OK), inserts finding with category/evidence and calls hook', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
    listProberTargetsMock.mockResolvedValueOnce([{ id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 }]);
    const ev = evidence({});
    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200, evidence: ev });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });

    expect(recordCheckMock).toHaveBeenCalledWith('t_admin', 200, expect.objectContaining({ verdict: 'open' }));
    expect(insertFindingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj_1',
        targetId: 't_admin',
        path: '/admin',
        method: 'GET',
        baselineStatus: 403,
        actualStatus: 200,
        severity: 'critical',
        variant: null,
        keyFingerprint: null,
        category: 'admin',
        evidence: expect.objectContaining({ bodyKind: 'html_app', title: 'Admin' }),
      }),
    );
    expect(summary.newFindings).toBe(1);
    expect(onNewFindings).toHaveBeenCalledTimes(1);
    expect(onNewFindings.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ path: '/admin', severity: 'critical', baselineStatus: 403, actualStatus: 200, variant: null, category: 'admin' }),
    ]);
  });

  it('does NOT flag a 200 that is really the login form, a soft-404 or the SPA shell', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
    listProberTargetsMock.mockResolvedValueOnce([
      { id: 't_a', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 401 },
      { id: 't_b', projectId: 'proj_1', path: '/dashboard', method: 'GET', baselineStatus: 307 },
      { id: 't_c', projectId: 'proj_1', path: '/settings', method: 'GET', baselineStatus: 302 },
    ]);
    probeTargetMock
      .mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ bodyKind: 'login_page', title: 'Sign in' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ bodyKind: 'soft_404', title: '404' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ bodyKind: 'spa_shell' }) });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });

    expect(insertFindingMock).not.toHaveBeenCalled();
    expect(onNewFindings).not.toHaveBeenCalled();
    expect(recordCheckMock).toHaveBeenCalledWith('t_a', 200, expect.objectContaining({ verdict: 'protected' }));
    expect(recordCheckMock).toHaveBeenCalledWith('t_b', 200, expect.objectContaining({ verdict: 'inconclusive' }));
    expect(recordCheckMock).toHaveBeenCalledWith('t_c', 200, expect.objectContaining({ verdict: 'inconclusive' }));
    expect(summary.inconclusive).toBe(2);
    expect(summary.checked).toBe(3);
  });

  it('touches existing finding without firing duplicate alert if regression persists', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
    listProberTargetsMock.mockResolvedValueOnce([{ id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 }]);
    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({}) });
    openFindings({ '/admin|null': { id: 'existing_finding_1' } });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });

    expect(touchFindingMock).toHaveBeenCalledWith('existing_finding_1');
    expect(insertFindingMock).not.toHaveBeenCalled();
    expect(summary.stillOpen).toBe(1);
    expect(summary.newFindings).toBe(0);
    expect(onNewFindings).not.toHaveBeenCalled();
  });

  it('auto-resolves open finding when endpoint returns protected status again', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
    listProberTargetsMock.mockResolvedValueOnce([{ id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 }]);
    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 403, evidence: evidence({ bodyKind: 'text', title: null }) });
    openFindings({ '/admin|null': { id: 'past_finding_id' } });

    const summary = await runAuthProber('proj_1');
    expect(autoResolveFindingMock).toHaveBeenCalledWith('past_finding_id');
    expect(autoResolveFindingMock).toHaveBeenCalledTimes(1);
    expect(summary.autoResolved).toBe(1);
    expect(summary.checked).toBe(1);
  });

  it('handles probe network errors gracefully without false alarms', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
    listProberTargetsMock.mockResolvedValueOnce([{ id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 }]);
    probeTargetMock.mockResolvedValueOnce({ ok: false, error: 'network_timeout' });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });
    expect(summary.errors).toBe(1);
    expect(summary.checked).toBe(0);
    expect(summary.newFindings).toBe(0);
    expect(onNewFindings).not.toHaveBeenCalled();
  });

  describe('exposure on first probe', () => {
    it('raises an "exposed" finding AND records the baseline when an API answers JSON data without login', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_api', projectId: 'proj_1', path: '/api/users', method: 'GET', baselineStatus: null }]);
      probeTargetMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        evidence: evidence({ contentType: 'application/json', bodyKind: 'json_data', title: null, bodySample: '[{"id":1,"email":"a@b.c"}]' }),
      });

      const onNewFindings = vi.fn();
      const summary = await runAuthProber('proj_1', { onNewFindings });

      expect(setBaselineMock).toHaveBeenCalledWith('t_api', 200, expect.objectContaining({ verdict: 'exposed' }));
      expect(insertFindingMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/users', variant: 'exposed', severity: 'critical', category: 'api', baselineStatus: 200, actualStatus: 200 }),
      );
      expect(summary.baselinesRecorded).toBe(1);
      expect(summary.newFindings).toBe(1);
      expect(onNewFindings).toHaveBeenCalledTimes(1);
    });

    it('does not treat an ordinary logged-in page (/dashboard) answering 200 at baseline as exposure', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_dash', projectId: 'proj_1', path: '/dashboard', method: 'GET', baselineStatus: null }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ title: 'Pricing' }) });

      const summary = await runAuthProber('proj_1');
      expect(insertFindingMock).not.toHaveBeenCalled();
      expect(setBaselineMock).toHaveBeenCalledWith('t_dash', 200, expect.objectContaining({ verdict: 'baseline_recorded' }));
      expect(summary.newFindings).toBe(0);
    });

    it('keeps an exposed finding alive on later runs and auto-resolves it once the route is protected', async () => {
      // Run 1: still open → touch, no new alert
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_dbg', projectId: 'proj_1', path: '/debug', method: 'GET', baselineStatus: 200 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ title: 'Debug' }) });
      openFindings({ '/debug|exposed': { id: 'f_exposed' } });
      const onNewFindings = vi.fn();
      let summary = await runAuthProber('proj_1', { onNewFindings });
      expect(touchFindingMock).toHaveBeenCalledWith('f_exposed');
      expect(insertFindingMock).not.toHaveBeenCalled();
      expect(summary.stillOpen).toBe(1);
      expect(onNewFindings).not.toHaveBeenCalled();

      // Run 2: now 401 → auto-resolve
      vi.clearAllMocks();
      listFindingsMock.mockResolvedValue([]);
      getOrRefreshProjectAnonKeyMock.mockResolvedValue(null);
      fetchHomeFingerprintMock.mockResolvedValue(null);
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_dbg', projectId: 'proj_1', path: '/debug', method: 'GET', baselineStatus: 200 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 401, evidence: evidence({ bodyKind: 'text', title: null }) });
      openFindings({ '/debug|exposed': { id: 'f_exposed' } });
      summary = await runAuthProber('proj_1');
      expect(autoResolveFindingMock).toHaveBeenCalledWith('f_exposed');
      expect(summary.autoResolved).toBe(1);
    });
  });

  describe('sequential-id (IDOR) check', () => {
    it('probes id=2 for [id] routes that returned JSON data and raises sequential_id when bodies differ', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_u', projectId: 'proj_1', path: '/api/users/[id]', method: 'GET', baselineStatus: null }]);
      probeTargetMock
        .mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ contentType: 'application/json', bodyKind: 'json_data', bodyHash: 'h1', title: null }) })
        .mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ contentType: 'application/json', bodyKind: 'json_data', bodyHash: 'h2', title: null }) });

      const summary = await runAuthProber('proj_1');

      expect(probeTargetMock).toHaveBeenCalledTimes(2);
      expect(probeTargetMock.mock.calls[1]).toEqual(['example.com', '/api/users/[id]', { idValue: '2' }]);
      const variants = insertFindingMock.mock.calls.map((c) => (c[0] as { variant: string }).variant).sort();
      expect(variants).toEqual(['exposed', 'sequential_id']);
      expect(summary.newFindings).toBe(2);
    });

    it('does not raise sequential_id when both ids return the same body (static/mock response)', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_u', projectId: 'proj_1', path: '/api/users/[id]', method: 'GET', baselineStatus: null }]);
      probeTargetMock
        .mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ contentType: 'application/json', bodyKind: 'json_data', bodyHash: 'same', title: null }) })
        .mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ contentType: 'application/json', bodyKind: 'json_data', bodyHash: 'same', title: null }) });

      await runAuthProber('proj_1');
      const variants = insertFindingMock.mock.calls.map((c) => (c[0] as { variant: string }).variant);
      expect(variants).toEqual(['exposed']);
    });

    it('skips the extra request for routes without an id placeholder', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_api', projectId: 'proj_1', path: '/api/users', method: 'GET', baselineStatus: null }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({ contentType: 'application/json', bodyKind: 'json_data', title: null }) });
      await runAuthProber('proj_1');
      expect(probeTargetMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('anon-key (Supabase RLS) variant', () => {
    it('skips anon probe when project has no anon key', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 403 });

      const summary = await runAuthProber('proj_1');
      expect(probeTargetWithAnonKeyMock).not.toHaveBeenCalled();
      expect(summary.checked).toBe(1);
      expect(summary.newFindings).toBe(0);
    });

    it('runs anon probe when target is protected and anon key exists, inserting finding with variant anon_role', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      getOrRefreshProjectAnonKeyMock.mockResolvedValueOnce({ key: 'eyJhbGciOi...', fingerprint: 'abc123def4567890' });
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_api', projectId: 'proj_1', path: '/api/data', method: 'GET', baselineStatus: 401 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 401 });
      probeTargetWithAnonKeyMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        evidence: evidence({ contentType: 'application/json', bodyKind: 'json_data', title: null }),
      });

      const onNewFindings = vi.fn();
      const summary = await runAuthProber('proj_1', { onNewFindings });

      expect(probeTargetWithAnonKeyMock).toHaveBeenCalledWith('example.com', '/api/data', 'eyJhbGciOi...', expect.anything());
      expect(insertFindingMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/api/data',
          baselineStatus: 401,
          actualStatus: 200,
          severity: 'critical',
          variant: 'anon_role',
          keyFingerprint: 'abc123def4567890',
          category: 'api',
        }),
      );
      expect(summary.newFindings).toBe(1);
      expect(onNewFindings).toHaveBeenCalledWith([
        expect.objectContaining({ path: '/api/data', variant: 'anon_role', keyFingerprint: 'abc123def4567890' }),
      ]);
    });

    it('anon probe answering 200 with an error-shaped JSON body is NOT an exposure', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      getOrRefreshProjectAnonKeyMock.mockResolvedValueOnce({ key: 'k', fingerprint: 'fp' });
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_api', projectId: 'proj_1', path: '/api/data', method: 'GET', baselineStatus: 401 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 401 });
      probeTargetWithAnonKeyMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        evidence: evidence({ contentType: 'application/json', bodyKind: 'json_error', title: null }),
      });
      const summary = await runAuthProber('proj_1');
      expect(insertFindingMock).not.toHaveBeenCalled();
      expect(summary.newFindings).toBe(0);
    });

    it('dedupes anon_role separately from a plain finding', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      getOrRefreshProjectAnonKeyMock.mockResolvedValueOnce({ key: 'k', fingerprint: 'fp' });
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_api', projectId: 'proj_1', path: '/api/data', method: 'GET', baselineStatus: 401 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 401 });
      probeTargetWithAnonKeyMock.mockResolvedValueOnce({ ok: true, status: 200 });
      openFindings({ '/api/data|anon_role': { id: 'existing_anon_finding_1' } });

      const summary = await runAuthProber('proj_1');
      expect(touchFindingMock).toHaveBeenCalledWith('existing_anon_finding_1');
      expect(insertFindingMock).not.toHaveBeenCalled();
      expect(autoResolveFindingMock).not.toHaveBeenCalled();
      expect(summary.stillOpen).toBe(1);
    });

    it('auto-resolves open anon_role finding when anon probe becomes protected again', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      getOrRefreshProjectAnonKeyMock.mockResolvedValueOnce({ key: 'k', fingerprint: 'fp' });
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_api', projectId: 'proj_1', path: '/api/data', method: 'GET', baselineStatus: 401 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 401 });
      probeTargetWithAnonKeyMock.mockResolvedValueOnce({ ok: true, status: 401 });
      openFindings({ '/api/data|anon_role': { id: 'past_anon_finding_1' } });

      const summary = await runAuthProber('proj_1');
      expect(autoResolveFindingMock).toHaveBeenCalledWith('past_anon_finding_1');
      expect(autoResolveFindingMock).toHaveBeenCalledTimes(1);
      expect(summary.autoResolved).toBe(1);
    });
  });

  describe('flapping suppression', () => {
    it('still records the finding but withholds the email when the path regressed ≥3 times in 30 days', async () => {
      getRuntimeProjectContextMock.mockResolvedValueOnce(VERIFIED);
      listProberTargetsMock.mockResolvedValueOnce([{ id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 }]);
      probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200, evidence: evidence({}) });
      const recent = new Date();
      listFindingsMock.mockResolvedValue([
        { path: '/admin', createdAt: recent },
        { path: '/admin', createdAt: recent },
        { path: '/admin', createdAt: recent },
      ]);

      const onNewFindings = vi.fn();
      const summary = await runAuthProber('proj_1', { onNewFindings });
      expect(insertFindingMock).toHaveBeenCalledTimes(1);
      expect(summary.newFindings).toBe(1);
      expect(summary.suppressedAlerts).toBe(1);
      expect(onNewFindings).not.toHaveBeenCalled();
    });
  });
});

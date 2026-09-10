import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getRuntimeProjectContextMock = vi.fn();
const listProberTargetsMock = vi.fn();
const seedProberTargetsMock = vi.fn();
const setBaselineMock = vi.fn();
const recordCheckMock = vi.fn();
const findUnresolvedFindingMock = vi.fn();
const insertFindingMock = vi.fn();
const touchFindingMock = vi.fn();
const autoResolveFindingMock = vi.fn();

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
}));

const probeTargetMock = vi.fn();
vi.mock('../lib/runtime/auth-prober/probe.ts', () => ({
  probeTarget: (...args: unknown[]) => probeTargetMock(...args),
}));

import { runAuthProber } from '../lib/runtime/auth-prober/engine.ts';

describe('runtime auth prober — engine execution flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips run if project does not exist or has no hostname', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce(null);

    const summary = await runAuthProber('proj_missing');
    expect(summary.checked).toBe(0);
    expect(summary.baselinesRecorded).toBe(0);
    expect(listProberTargetsMock).not.toHaveBeenCalled();
  });

  it('skips run if domain is unverified to prevent abuse', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_unverified',
      hostname: 'unverified.com',
      isVerified: false,
    });

    const summary = await runAuthProber('proj_unverified');
    expect(summary.checked).toBe(0);
    expect(listProberTargetsMock).not.toHaveBeenCalled();
  });

  it('seeds default targets if no targets exist initially', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_1',
      hostname: 'example.com',
      isVerified: true,
    });

    // First call empty, second call returns seeded targets
    listProberTargetsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 't_1', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: null },
      ]);

    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 401 });

    const summary = await runAuthProber('proj_1');
    expect(seedProberTargetsMock).toHaveBeenCalledTimes(1);
    expect(setBaselineMock).toHaveBeenCalledWith('t_1', 401);
    expect(summary.baselinesRecorded).toBe(1);
  });

  it('records initial baseline on first probe without raising findings', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_1',
      hostname: 'example.com',
      isVerified: true,
    });

    listProberTargetsMock.mockResolvedValueOnce([
      { id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: null },
    ]);

    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 403 });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });

    expect(setBaselineMock).toHaveBeenCalledWith('t_admin', 403);
    expect(summary.baselinesRecorded).toBe(1);
    expect(summary.newFindings).toBe(0);
    expect(onNewFindings).not.toHaveBeenCalled();
  });

  it('detects regression (protected → 200 OK), inserts finding and calls hook', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_1',
      hostname: 'example.com',
      isVerified: true,
    });

    listProberTargetsMock.mockResolvedValueOnce([
      { id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 },
    ]);

    // Probe returns 200 OK (unauthenticated access permitted!)
    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200 });
    findUnresolvedFindingMock.mockResolvedValueOnce(null);
    insertFindingMock.mockResolvedValueOnce({
      id: 'f_1',
      path: '/admin',
      severity: 'critical',
      baselineStatus: 403,
      actualStatus: 200,
    });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });

    expect(recordCheckMock).toHaveBeenCalledWith('t_admin', 200);
    expect(insertFindingMock).toHaveBeenCalledWith({
      projectId: 'proj_1',
      targetId: 't_admin',
      path: '/admin',
      method: 'GET',
      baselineStatus: 403,
      actualStatus: 200,
      severity: 'critical',
    });
    expect(summary.newFindings).toBe(1);
    expect(onNewFindings).toHaveBeenCalledWith([
      {
        path: '/admin',
        severity: 'critical',
        baselineStatus: 403,
        actualStatus: 200,
      },
    ]);
  });

  it('touches existing finding without firing duplicate alert if regression persists', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_1',
      hostname: 'example.com',
      isVerified: true,
    });

    listProberTargetsMock.mockResolvedValueOnce([
      { id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 },
    ]);

    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 200 });
    findUnresolvedFindingMock.mockResolvedValueOnce({ id: 'existing_finding_1' });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });

    expect(touchFindingMock).toHaveBeenCalledWith('existing_finding_1');
    expect(insertFindingMock).not.toHaveBeenCalled();
    expect(summary.stillOpen).toBe(1);
    expect(summary.newFindings).toBe(0);
    expect(onNewFindings).not.toHaveBeenCalled();
  });

  it('auto-resolves open finding when endpoint returns protected status again', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_1',
      hostname: 'example.com',
      isVerified: true,
    });

    listProberTargetsMock.mockResolvedValueOnce([
      { id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 },
    ]);

    // Now protected again (e.g. 403 Forbidden or 307 Redirect)
    probeTargetMock.mockResolvedValueOnce({ ok: true, status: 403 });
    findUnresolvedFindingMock.mockResolvedValueOnce({ id: 'past_finding_id' });

    const summary = await runAuthProber('proj_1');
    expect(autoResolveFindingMock).toHaveBeenCalledWith('past_finding_id');
    expect(summary.autoResolved).toBe(1);
    expect(summary.checked).toBe(1);
  });

  it('handles probe network errors gracefully without false alarms', async () => {
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_1',
      hostname: 'example.com',
      isVerified: true,
    });

    listProberTargetsMock.mockResolvedValueOnce([
      { id: 't_admin', projectId: 'proj_1', path: '/admin', method: 'GET', baselineStatus: 403 },
    ]);

    probeTargetMock.mockResolvedValueOnce({ ok: false, error: 'network_timeout' });

    const onNewFindings = vi.fn();
    const summary = await runAuthProber('proj_1', { onNewFindings });

    expect(summary.errors).toBe(1);
    expect(summary.checked).toBe(0);
    expect(summary.newFindings).toBe(0);
    expect(onNewFindings).not.toHaveBeenCalled();
  });
});

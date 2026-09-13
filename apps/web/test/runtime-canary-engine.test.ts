import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCanaryProjectConfigMock = vi.fn();
const listCanariesMock = vi.fn();
const updateCanaryStatusMock = vi.fn();
const insertCanaryEventsMock = vi.fn();
const markCanariesSetupMock = vi.fn();
const hasRecentDuplicateEventMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  getCanaryProjectConfig: (...args: unknown[]) => getCanaryProjectConfigMock(...args),
  listCanaries: (...args: unknown[]) => listCanariesMock(...args),
  updateCanaryStatus: (...args: unknown[]) => updateCanaryStatusMock(...args),
  insertCanaryEvents: (...args: unknown[]) => insertCanaryEventsMock(...args),
  markCanariesSetup: (...args: unknown[]) => markCanariesSetupMock(...args),
  hasRecentDuplicateEvent: (...args: unknown[]) => hasRecentDuplicateEventMock(...args),
}));

vi.mock('@/lib/header-encryption', () => ({
  decryptValue: vi.fn((v: string) => `decrypted_${v}`),
}));

const restSelectMock = vi.fn();
vi.mock('@/lib/runtime/canaries/supabase-rest', () => ({
  restSelect: (...args: unknown[]) => restSelectMock(...args),
  listTableNames: vi.fn(),
}));

import { runCanaryCheck } from '@/lib/runtime/canaries/engine';
import { sha256Canonical } from '@/lib/runtime/canaries/integrity';

describe('runCanaryCheck — credentials invalid & reachability handling (TASK 1)', () => {
  const projectId = 'proj_test_123';
  const existingSnapshot = {
    payloadHashes: {
      'CANARY::test::A': 'abc123hash',
      'CANARY::test::B': 'def456hash',
    },
    logRowCount: 5,
    takenAt: '2026-09-01T00:00:00.000Z',
  };

  const plantedCanaries = [
    { id: 'c1', markerToken: 'CANARY::test::A', status: 'planted' },
    { id: 'c2', markerToken: 'CANARY::test::B', status: 'planted' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    hasRecentDuplicateEventMock.mockResolvedValue(false);
    getCanaryProjectConfigMock.mockResolvedValue({
      projectId,
      supabaseUrl: 'https://test-ref.supabase.co',
      serviceKey: 'test_service_key',
      anonKey: 'test_anon_key',
      snapshot: existingSnapshot,
    });
    listCanariesMock.mockResolvedValue(plantedCanaries);
  });

  it('rowsRes status 401 with existing snapshot → zero detections, snapshot untouched', async () => {
    // Supabase JWT expired or rotated → returns 401
    restSelectMock.mockResolvedValueOnce({
      status: 401,
      ok: false,
      data: null,
      count: null,
    });

    const summary = await runCanaryCheck(projectId);

    // 1. Must be marked unreachable
    expect(summary.reachable).toBe(false);

    // 2. ZERO detections (must NOT mark every canary as 'deleted')
    expect(summary.detections).toHaveLength(0);

    // 3. Snapshot must NOT be refreshed / updated
    expect(markCanariesSetupMock).not.toHaveBeenCalled();

    // 4. No false events inserted
    expect(insertCanaryEventsMock).not.toHaveBeenCalled();

    // 5. Neutral 'unreachable' integrity set on canaries, preserving existing status
    expect(updateCanaryStatusMock).toHaveBeenCalledWith(projectId, 'CANARY::test::A', 'planted', 'unreachable');
    expect(updateCanaryStatusMock).toHaveBeenCalledWith(projectId, 'CANARY::test::B', 'planted', 'unreachable');
    expect(summary.integrity['CANARY::test::A']).toBe('unreachable');
    expect(summary.integrity['CANARY::test::B']).toBe('unreachable');
  });

  it('rowsRes status 403, 500, or 0 (timeout) → zero detections, snapshot untouched', async () => {
    for (const errorStatus of [403, 500, 503, 0]) {
      vi.clearAllMocks();
      getCanaryProjectConfigMock.mockResolvedValue({
        projectId,
        supabaseUrl: 'https://test-ref.supabase.co',
        serviceKey: 'test_service_key',
        anonKey: 'test_anon_key',
        snapshot: existingSnapshot,
      });
      listCanariesMock.mockResolvedValue(plantedCanaries);

      restSelectMock.mockResolvedValueOnce({
        status: errorStatus,
        ok: false,
        data: null,
        count: null,
      });

      const summary = await runCanaryCheck(projectId);

      expect(summary.reachable).toBe(false);
      expect(summary.detections).toHaveLength(0);
      expect(markCanariesSetupMock).not.toHaveBeenCalled();
      expect(insertCanaryEventsMock).not.toHaveBeenCalled();
      expect(summary.integrity['CANARY::test::A']).toBe('unreachable');
    }
  });

  it('rowsRes status 404 → produces table_missing detection and leaves snapshot untouched', async () => {
    restSelectMock.mockResolvedValueOnce({
      status: 404,
      ok: false,
      data: null,
      count: null,
    });

    const summary = await runCanaryCheck(projectId);

    expect(summary.reachable).toBe(false);
    expect(summary.detections).toHaveLength(1);
    expect(summary.detections[0]?.kind).toBe('table_missing');
    expect(insertCanaryEventsMock).toHaveBeenCalled();
    expect(markCanariesSetupMock).not.toHaveBeenCalled();
  });

  it('rowsRes status 200 (ok) → evaluates integrity and refreshes snapshot if intact', async () => {
    const notePayload = { note: 'legacy' };
    const hash = sha256Canonical(notePayload);
    getCanaryProjectConfigMock.mockResolvedValueOnce({
      projectId,
      supabaseUrl: 'https://test-ref.supabase.co',
      serviceKey: 'test_service_key',
      anonKey: 'test_anon_key',
      snapshot: {
        payloadHashes: {
          'CANARY::test::A': hash,
          'CANARY::test::B': hash,
        },
        logRowCount: 5,
        takenAt: '2026-09-01T00:00:00.000Z',
      },
    });

    // 1st call: rowsRes (select CANARY_TABLE)
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [
        { marker: 'CANARY::test::A', payload: notePayload },
        { marker: 'CANARY::test::B', payload: notePayload },
      ],
      count: null,
    });
    // 2nd call: logRes (select CANARY_LOG_TABLE)
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      count: 5,
    });
    // 3rd call: RLS probe (anon key select)
    restSelectMock.mockResolvedValueOnce({
      status: 401,
      ok: false,
      data: null,
      count: null,
    });

    const summary = await runCanaryCheck(projectId);

    expect(summary.reachable).toBe(true);
    expect(markCanariesSetupMock).toHaveBeenCalled();
  });
});

describe('runCanaryCheck — nightly event dedupe (TASK 3)', () => {
  const projectId = 'proj_dedupe_456';
  const baselineHash = sha256Canonical({ note: 'original' });
  const snapshot = {
    payloadHashes: {
      'CANARY::test::A': baselineHash,
    },
    logRowCount: 5,
    takenAt: '2026-09-01T00:00:00.000Z',
  };
  const canaries = [{ id: 'canary_1', markerToken: 'CANARY::test::A', status: 'planted' }];

  beforeEach(() => {
    vi.clearAllMocks();
    getCanaryProjectConfigMock.mockResolvedValue({
      projectId,
      supabaseUrl: 'https://test-ref.supabase.co',
      serviceKey: 'test_service_key',
      anonKey: null,
      snapshot,
    });
    listCanariesMock.mockResolvedValue(canaries);
  });

  it('same modified-row detection on two consecutive runs → 1 event row total, email hook called once', async () => {
    const emailHook = vi.fn();

    // Helper simulating runner (e.g. nightly Inngest job)
    const runJob = async () => {
      const summary = await runCanaryCheck(projectId);
      if (summary.detections.length > 0) {
        emailHook(summary.detections);
      }
      return summary;
    };

    const tamperedPayload = { note: 'ATTACKER_EDIT' };

    // ─── RUN 1: First time detection ─────────────────────────────
    // Mock REST response: modified row
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [{ marker: 'CANARY::test::A', payload: tamperedPayload }],
      count: null,
    });
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [{ id: 1 }],
      count: 5,
    });
    // hasRecentDuplicateEvent returns false (never seen before)
    hasRecentDuplicateEventMock.mockResolvedValueOnce(false);

    const summary1 = await runJob();

    // Run 1 checks:
    expect(summary1.detections).toHaveLength(1);
    expect(summary1.detections[0]?.kind).toBe('modified');
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
    expect(emailHook).toHaveBeenCalledTimes(1);
    expect(markCanariesSetupMock).not.toHaveBeenCalled(); // Tampered state must not become new baseline!

    // ─── RUN 2: Consecutive run (within 24h) ──────────────────────
    // Row is still modified in user's database
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [{ marker: 'CANARY::test::A', payload: tamperedPayload }],
      count: null,
    });
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [{ id: 1 }],
      count: 5,
    });
    // hasRecentDuplicateEvent now returns true (duplicate within window)
    hasRecentDuplicateEventMock.mockResolvedValueOnce(true);

    const summary2 = await runJob();

    // Run 2 checks:
    expect(summary2.detections).toHaveLength(0); // Filtered out / suppressed!
    // Total insertCanaryEventsMock calls across BOTH runs remains 1!
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
    // Total emailHook calls across BOTH runs remains 1!
    expect(emailHook).toHaveBeenCalledTimes(1);
    expect(markCanariesSetupMock).not.toHaveBeenCalled();
  });

  it('partially duplicate batch: keeps new detections and filters duplicates', async () => {
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [
        { marker: 'CANARY::test::A', payload: { note: 'modified_A' } },
        { marker: 'CANARY::test::B', payload: { note: 'modified_B' } },
      ],
      count: null,
    });
    restSelectMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: [],
      count: 5,
    });

    getCanaryProjectConfigMock.mockResolvedValueOnce({
      projectId,
      supabaseUrl: 'https://test-ref.supabase.co',
      serviceKey: 'test_service_key',
      anonKey: null,
      snapshot: {
        payloadHashes: {
          'CANARY::test::A': 'old_hash_A',
          'CANARY::test::B': 'old_hash_B',
        },
        logRowCount: 5,
        takenAt: '2026-09-01T00:00:00.000Z',
      },
    });

    listCanariesMock.mockResolvedValueOnce([
      { id: 'c1', markerToken: 'CANARY::test::A', status: 'planted' },
      { id: 'c2', markerToken: 'CANARY::test::B', status: 'planted' },
    ]);

    // A is duplicate (true), B is new (false)
    hasRecentDuplicateEventMock.mockImplementation(async (_pid: string, _kind: string, detail: string) => {
      return detail.includes('CANARY::test::A');
    });

    const summary = await runCanaryCheck(projectId);

    // Only B should be in summary.detections and inserted
    expect(summary.detections).toHaveLength(1);
    expect(summary.detections[0]?.detail).toContain('CANARY::test::B');
    expect(insertCanaryEventsMock).toHaveBeenCalledWith([
      expect.objectContaining({ detail: expect.stringContaining('CANARY::test::B') }),
    ]);
  });
});

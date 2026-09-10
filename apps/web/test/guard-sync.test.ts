import { beforeEach, describe, expect, it, vi } from 'vitest';

const listGuardRoutesMock = vi.fn();
const seedProberTargetsMock = vi.fn();
const upgradeProberTargetSourceMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  listGuardRoutes: (...args: unknown[]) => listGuardRoutesMock(...args),
  seedProberTargets: (...args: unknown[]) => seedProberTargetsMock(...args),
  upgradeProberTargetSource: (...args: unknown[]) => upgradeProberTargetSourceMock(...args),
}));

import { syncGuardRoutesToProber } from '../lib/runtime/guard/sync.ts';

describe('syncGuardRoutesToProber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zero when no routes are observed', async () => {
    listGuardRoutesMock.mockResolvedValueOnce([]);

    const result = await syncGuardRoutesToProber('proj_1');
    expect(result).toEqual({ synced: 0, candidates: 0 });
    expect(seedProberTargetsMock).not.toHaveBeenCalled();
    expect(upgradeProberTargetSourceMock).not.toHaveBeenCalled();
  });

  it('syncs only GET routes that need a session and ignores mutations / public routes', async () => {
    listGuardRoutesMock.mockResolvedValueOnce([
      // Protected GET route (98% with session) → should sync
      {
        id: 'r1',
        pattern: '/admin/settings',
        method: 'GET',
        kind: 'route',
        withSession: 98,
        withoutSession: 2,
      },
      // Server action (mutation) → should NOT sync to prober
      {
        id: 'r2',
        pattern: '/api/update-profile',
        method: 'POST',
        kind: 'server_action',
        withSession: 100,
        withoutSession: 0,
      },
      // Mutation HTTP method (POST) → should NOT sync
      {
        id: 'r3',
        pattern: '/api/orders',
        method: 'POST',
        kind: 'route',
        withSession: 50,
        withoutSession: 0,
      },
      // Public route (mostly without session) → should NOT sync
      {
        id: 'r4',
        pattern: '/blog/[id]',
        method: 'GET',
        kind: 'route',
        withSession: 5,
        withoutSession: 95,
      },
    ]);

    const result = await syncGuardRoutesToProber('proj_1');

    expect(result).toEqual({ synced: 1, candidates: 4 });
    expect(seedProberTargetsMock).toHaveBeenCalledWith('proj_1', [
      { path: '/admin/settings', method: 'GET', source: 'guard' },
    ]);
    expect(upgradeProberTargetSourceMock).toHaveBeenCalledWith('proj_1', [
      { path: '/admin/settings', method: 'GET', source: 'guard' },
    ]);
  });

  it('caps synced routes to 50 for politeness', async () => {
    const manyRoutes = Array.from({ length: 60 }, (_, i) => ({
      id: `r_${i}`,
      pattern: `/dashboard/item/${i}`,
      method: 'GET',
      kind: 'route',
      withSession: 10,
      withoutSession: 0,
    }));

    listGuardRoutesMock.mockResolvedValueOnce(manyRoutes);

    const result = await syncGuardRoutesToProber('proj_1');
    expect(result.synced).toBe(50);
    expect(result.candidates).toBe(60);
    expect(seedProberTargetsMock).toHaveBeenCalledWith(
      'proj_1',
      expect.arrayContaining([expect.objectContaining({ source: 'guard' })]),
    );
  });
});

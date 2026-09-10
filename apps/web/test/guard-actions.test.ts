import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireUserMock = vi.fn();
vi.mock('../lib/authz.ts', () => ({
  requireUser: (...args: unknown[]) => requireUserMock(...args),
}));

const getProjectMock = vi.fn();
vi.mock('@scanlyfix/db', () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
}));

const syncGuardRoutesToProberMock = vi.fn();
vi.mock('../lib/runtime/guard/sync.ts', () => ({
  syncGuardRoutesToProber: (...args: unknown[]) => syncGuardRoutesToProberMock(...args),
}));

const revalidatePathMock = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

import { refreshGuardAction } from '../app/(app)/runtime/guard/actions.ts';

describe('refreshGuardAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not_found if user does not own the project', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce(null);

    const result = await refreshGuardAction('proj_other');
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(syncGuardRoutesToProberMock).not.toHaveBeenCalled();
  });

  it('syncs routes and revalidates runtime paths when authorized', async () => {
    requireUserMock.mockResolvedValueOnce({ id: 'user_1' });
    getProjectMock.mockResolvedValueOnce({ id: 'proj_1', name: 'My App' });
    syncGuardRoutesToProberMock.mockResolvedValueOnce({ synced: 4, candidates: 10 });

    const result = await refreshGuardAction('proj_1');
    expect(result).toEqual({ ok: true, syncedTargets: 4 });
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/guard');
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime');
    expect(revalidatePathMock).toHaveBeenCalledWith('/runtime/probers');
  });

  it('handles unexpected errors gracefully', async () => {
    requireUserMock.mockRejectedValueOnce(new Error('unauthenticated'));

    const result = await refreshGuardAction('proj_1');
    expect(result).toEqual({ ok: false, error: 'refresh_failed' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getViewerMock = vi.fn();
const getProjectMock = vi.fn();
const listCanariesMock = vi.fn();
const retireCanariesMock = vi.fn();
const seedCanariesMock = vi.fn();
const acknowledgeCanaryEventMock = vi.fn();

vi.mock('@/lib/authz', () => ({
  requireUser: vi.fn().mockResolvedValue({ id: 'user-123' }),
  getViewer: (...args: unknown[]) => getViewerMock(...args),
}));

vi.mock('@scanlyfix/db', () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
  listCanaries: (...args: unknown[]) => listCanariesMock(...args),
  retireCanaries: (...args: unknown[]) => retireCanariesMock(...args),
  seedCanaries: (...args: unknown[]) => seedCanariesMock(...args),
  acknowledgeCanaryEvent: (...args: unknown[]) => acknowledgeCanaryEventMock(...args),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { markEventReviewedAction, rePlantCanariesAction } from '../app/(app)/runtime/canaries/action';

describe('rePlantCanariesAction — compromise recovery flow (TASK 7)', () => {
  const projectId = 'proj-recov-1';
  const project = { id: projectId, name: 'Recovery Project' };

  beforeEach(() => {
    vi.clearAllMocks();
    getViewerMock.mockResolvedValue({ kind: 'user', userId: 'user-123' });
    getProjectMock.mockResolvedValue(project);
  });

  it('rejects if no canaries exist', async () => {
    listCanariesMock.mockResolvedValue([]);

    const res = await rePlantCanariesAction(projectId);
    expect(res).toEqual({ ok: false, error: 'no_canaries_found' });
    expect(retireCanariesMock).not.toHaveBeenCalled();
  });

  it('rejects if canaries exist but are only pending_script', async () => {
    listCanariesMock.mockResolvedValue([
      { id: 'c1', markerToken: 'CANARY::old::A', status: 'pending_script' },
    ]);

    const res = await rePlantCanariesAction(projectId);
    expect(res).toEqual({ ok: false, error: 'canaries_not_eligible_for_replant' });
    expect(retireCanariesMock).not.toHaveBeenCalled();
  });

  it('allows replant when canaries are compromised → retires old, seeds fresh script', async () => {
    listCanariesMock.mockResolvedValue([
      { id: 'c1', markerToken: 'CANARY::old::A', status: 'compromised' },
      { id: 'c2', markerToken: 'CANARY::old::B', status: 'planted' },
    ]);

    const res = await rePlantCanariesAction(projectId);

    expect(res.ok).toBe(true);
    if (res.ok && res.data) {
      expect(res.data.sql).toContain('create table if not exists public.scanlyfix_canaries');
      expect(res.data.sql).toContain('security definer');
    }

    // 1. Marks old rows retired
    expect(retireCanariesMock).toHaveBeenCalledWith(projectId);

    // 2. Seeds new canary markers into DB with status pending_script
    expect(seedCanariesMock).toHaveBeenCalledWith(
      projectId,
      expect.arrayContaining([
        expect.objectContaining({
          marker: expect.stringMatching(/^CANARY::proj-rec::[ABC]$/),
        }),
      ]),
    );
  });

  it('allows replant when canaries are planted', async () => {
    listCanariesMock.mockResolvedValue([
      { id: 'c1', markerToken: 'CANARY::old::A', status: 'planted' },
    ]);

    const res = await rePlantCanariesAction(projectId);
    expect(res.ok).toBe(true);
    expect(retireCanariesMock).toHaveBeenCalledWith(projectId);
    expect(seedCanariesMock).toHaveBeenCalled();
  });
});

describe('markEventReviewedAction — acknowledge without deleting evidence (TASK 7)', () => {
  const projectId = 'proj-recov-1';
  const eventId = 'event-uuid-777';

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectMock.mockResolvedValue({ id: projectId });
  });

  it('calls acknowledgeCanaryEvent to set acknowledged_at timestamp', async () => {
    const res = await markEventReviewedAction(projectId, eventId);

    expect(res).toEqual({ ok: true });
    expect(acknowledgeCanaryEventMock).toHaveBeenCalledWith(projectId, eventId);
  });
});

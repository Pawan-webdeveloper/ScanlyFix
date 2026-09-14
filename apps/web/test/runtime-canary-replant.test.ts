import { beforeEach, describe, expect, it, vi } from 'vitest';

const getViewerMock = vi.fn();
const getProjectMock = vi.fn();
const listCanariesMock = vi.fn();
const retireCanariesMock = vi.fn();
const seedCanariesMock = vi.fn();
const acknowledgeCanaryEventMock = vi.fn();

vi.mock('@/lib/entitlements', () => ({
  // The Pro gate is exercised by its own test; here it is always open so these
  // tests keep covering what they are about.
  hasRuntimeAccess: async () => true,
}));

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
import { buildSetupScript } from '../lib/runtime/canaries/setup-script.ts';

/**
 * Compromise recovery — the path that was entirely broken.
 *
 * Markers used to be derived from the project id alone, so every script for a
 * project produced the same three. `seedCanaries` upserts on
 * (projectId, markerToken) with ON CONFLICT DO NOTHING, so after the old rows
 * were retired the "fresh" ones collided with them and were dropped: the
 * project ended up with no live decoys, the SQL the customer pasted carried new
 * random honeytoken paths that matched nothing we had stored, and the verify
 * step then reported success because there were no markers left to look for.
 */
describe('rePlantCanariesAction — compromise recovery', () => {
  const projectId = 'proj-recov-1';
  const project = { id: projectId, name: 'Recovery Project' };

  beforeEach(() => {
    vi.clearAllMocks();
    getViewerMock.mockResolvedValue({ kind: 'user', userId: 'user-123' });
    getProjectMock.mockResolvedValue(project);
    // Four rows: three decoys plus the self-test row.
    seedCanariesMock.mockImplementation(async (_p: string, seeds: unknown[]) => seeds.length);
  });

  it('refuses when there is nothing to re-plant', async () => {
    listCanariesMock.mockResolvedValue([]);
    const res = await rePlantCanariesAction(projectId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nothing to re-plant/i);
    expect(seedCanariesMock).not.toHaveBeenCalled();
  });

  it('retires the old decoys and registers genuinely new markers', async () => {
    listCanariesMock.mockResolvedValue([
      { id: 'c1', markerToken: 'CANARY::proj-rec::old1::A', status: 'compromised' },
    ]);

    const res = await rePlantCanariesAction(projectId);

    expect(res.ok).toBe(true);
    expect(retireCanariesMock).toHaveBeenCalledWith(projectId);

    const seeded = seedCanariesMock.mock.calls[0]![1] as Array<{ marker: string; honeytokenPath: string; kind?: string }>;
    // Three decoys plus one self-test row.
    expect(seeded).toHaveLength(4);
    expect(seeded.filter((x) => x.kind === 'selftest')).toHaveLength(1);
    // Nothing collides with the retired marker.
    expect(seeded.every((x) => x.marker !== 'CANARY::proj-rec::old1::A')).toBe(true);
    // Every honeytoken path is distinct and actually stored.
    expect(new Set(seeded.map((x) => x.honeytokenPath)).size).toBe(4);
  });

  it('produces different markers every time, so a second planting cannot be dropped as a conflict', () => {
    const first = buildSetupScript({ projectId, appDomain: 'app.test' });
    const second = buildSetupScript({ projectId, appDomain: 'app.test' });

    expect(first.plantId).not.toBe(second.plantId);
    const firstMarkers = new Set(first.seeds.map((s) => s.marker));
    for (const seed of second.seeds) expect(firstMarkers.has(seed.marker)).toBe(false);
    expect(first.selfTest.marker).not.toBe(second.selfTest.marker);
  });

  it('fails loudly rather than quietly when the database drops a decoy', async () => {
    listCanariesMock.mockResolvedValue([{ id: 'c1', markerToken: 'x', status: 'planted' }]);
    // A conflict means honeytoken paths in the SQL were never stored.
    seedCanariesMock.mockResolvedValue(2);

    const res = await rePlantCanariesAction(projectId);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not be re-planted/i);
  });

  it('considers retired rows, so recovery works even after everything was retired', async () => {
    listCanariesMock.mockResolvedValue([{ id: 'c1', markerToken: 'x', status: 'retired' }]);
    const res = await rePlantCanariesAction(projectId);
    expect(res.ok).toBe(true);
    expect(listCanariesMock).toHaveBeenCalledWith(projectId, { includeRetired: true });
  });
});

describe('markEventReviewedAction', () => {
  const projectId = 'proj-recov-1';

  beforeEach(() => {
    vi.clearAllMocks();
    getViewerMock.mockResolvedValue({ kind: 'user', userId: 'user-123' });
    getProjectMock.mockResolvedValue({ id: projectId, name: 'p' });
  });

  it('acknowledges without deleting the evidence', async () => {
    const res = await markEventReviewedAction(projectId, 'evt-1');
    expect(res.ok).toBe(true);
    expect(acknowledgeCanaryEventMock).toHaveBeenCalledWith(projectId, 'evt-1');
  });
});

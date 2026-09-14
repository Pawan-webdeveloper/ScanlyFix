'use server';

import { revalidatePath } from 'next/cache';
import {
  clearGuardRoutes,
  getOrCreateRuntimeSecret,
  getProject,
  rotateRuntimeSecret,
  seedDemoGuardRoutes,
} from '@scanlyfix/db';

import { requireUser } from '@/lib/authz.ts';
import { describeSyncResult } from '@/lib/runtime/guard/summary.ts';
import { syncGuardRoutesToProber } from '@/lib/runtime/guard/sync.ts';

/** Every Guard page under /runtime reads from the same tables. */
const GUARD_PATHS = ['/runtime/guard', '/runtime', '/runtime/probers'] as const;

function revalidateGuard(): void {
  for (const path of GUARD_PATHS) revalidatePath(path);
}

/** Thrown when the caller does not own the project, so it can be mapped to a stable code. */
class NotFoundError extends Error {
  constructor() {
    super('not_found');
    this.name = 'NotFoundError';
  }
}

/**
 * Confirms the caller owns the project before anything else runs.
 * Throws rather than returning, so a forgotten check cannot fall through.
 */
async function assertOwnership(projectId: string): Promise<{ id: string; name: string }> {
  const user = await requireUser();
  const project = await getProject(projectId, { kind: 'user', userId: user.id });
  if (!project) throw new NotFoundError();
  return { id: project.id, name: project.name };
}

/**
 * Maps a thrown error to a stable code for the client.
 *
 * The real error is logged server-side and never returned: a database or
 * driver message can carry connection details, table names and occasionally
 * fragments of the query, none of which belong in a browser response.
 */
function toActionError(scope: string, err: unknown, fallback: string): string {
  console.error(`[${scope}] error:`, err);
  return err instanceof NotFoundError ? 'not_found' : fallback;
}

export type SyncGuardResult =
  | {
      ok: true;
      syncedTargets: number;
      skippedUnverifiable: number;
      skippedStale: number;
      message: string;
    }
  | { ok: false; error: string };

/** "Sync to prober" — hands every fresh logged-in GET surface to the nightly check. */
export async function refreshGuardAction(projectId: string): Promise<SyncGuardResult> {
  try {
    await assertOwnership(projectId);
    const result = await syncGuardRoutesToProber(projectId);
    revalidateGuard();
    return {
      ok: true,
      syncedTargets: result.synced,
      skippedUnverifiable: result.skippedUnverifiable,
      skippedStale: result.skippedStale,
      message: describeSyncResult(result),
    };
  } catch (err) {
    return { ok: false, error: toActionError('refreshGuardAction', err, 'refresh_failed') };
  }
}

export type SeedSampleResult = { ok: true; seededRoutes: number } | { ok: false; error: string };

/** Seeds labelled demo rows so a new project can see what the dashboard does. */
export async function simulateSampleTrafficAction(projectId: string): Promise<SeedSampleResult> {
  try {
    await assertOwnership(projectId);
    const seededRoutes = await seedDemoGuardRoutes(projectId);
    revalidatePath('/runtime/guard');
    return { ok: true, seededRoutes };
  } catch (err) {
    return { ok: false, error: toActionError('simulateSampleTrafficAction', err, 'simulate_failed') };
  }
}

export type ClearGuardRoutesResult =
  | { ok: true; deletedRoutes: number; deletedTargets: number }
  | { ok: false; error: string };

/**
 * Deletes the observed inventory and the prober targets that came from it.
 * Manual and default targets survive — the developer chose those.
 */
export async function clearGuardRoutesAction(
  projectId: string,
  confirmation?: string,
): Promise<ClearGuardRoutesResult> {
  try {
    const project = await assertOwnership(projectId);

    const normalized = confirmation?.trim();
    const confirmed =
      normalized !== undefined &&
      normalized.length > 0 &&
      (normalized.toUpperCase() === 'CLEAR' || normalized === project.name);
    if (!confirmed) return { ok: false, error: 'confirmation_required' };

    const result = await clearGuardRoutes(projectId);
    revalidateGuard();
    return { ok: true, deletedRoutes: result.deletedRoutes, deletedTargets: result.deletedTargets };
  } catch (err) {
    return { ok: false, error: toActionError('clearGuardRoutesAction', err, 'clear_failed') };
  }
}

export type RuntimeSecretResult = { ok: true; secret: string } | { ok: false; error: string };

/**
 * Returns (or lazily generates) the per-project Runtime signing secret.
 * Safe to call on every Guard setup card mount — idempotent, never rotates.
 */
export async function getOrCreateRuntimeSecretAction(projectId: string): Promise<RuntimeSecretResult> {
  try {
    await assertOwnership(projectId);
    const secret = await getOrCreateRuntimeSecret(projectId);
    return { ok: true, secret };
  } catch (err) {
    return { ok: false, error: toActionError('getOrCreateRuntimeSecretAction', err, 'secret_fetch_failed') };
  }
}

/**
 * Rotates the Runtime signing secret. The previous one keeps working for 24
 * hours so a deploy can catch up before the SDK starts receiving 401s.
 */
export async function rotateRuntimeSecretAction(projectId: string): Promise<RuntimeSecretResult> {
  try {
    const user = await requireUser();
    const newSecret = await rotateRuntimeSecret(projectId, { kind: 'user', userId: user.id });
    if (!newSecret) return { ok: false, error: 'not_found' };
    return { ok: true, secret: newSecret };
  } catch (err) {
    return { ok: false, error: toActionError('rotateRuntimeSecretAction', err, 'rotate_failed') };
  }
}

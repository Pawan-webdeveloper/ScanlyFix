'use server';

import { revalidatePath } from 'next/cache';
import { getProject } from '@scanlyfix/db';
import { requireUser } from '../../../../lib/authz.ts';
import { syncGuardRoutesToProber } from '../../../../lib/runtime/guard/sync.ts';

export type GuardActionResult =
  | { ok: true; syncedTargets: number }
  | { ok: false; error: string };

/** Refresh button — syncs discovered guard routes to prober targets. */
export async function refreshGuardAction(projectId: string): Promise<GuardActionResult> {
  try {
    const user = await requireUser();
    const project = await getProject(projectId, { kind: 'user', userId: user.id });
    if (!project) return { ok: false, error: 'not_found' };

    const { synced } = await syncGuardRoutesToProber(projectId);

    revalidatePath('/runtime/guard');
    revalidatePath('/runtime');
    revalidatePath('/runtime/probers');
    return { ok: true, syncedTargets: synced };
  } catch (err) {
    console.error('[refreshGuardAction] error:', err);
    return { ok: false, error: 'refresh_failed' };
  }
}

/** In dev/testing, allows seeding realistic route telemetry with 1 click. */
export async function simulateSampleTrafficAction(projectId: string): Promise<GuardActionResult> {
  try {
    const user = await requireUser();
    const project = await getProject(projectId, { kind: 'user', userId: user.id });
    if (!project) return { ok: false, error: 'not_found' };

    const { seedDemoGuardRoutes } = await import('@scanlyfix/db');
    await seedDemoGuardRoutes(projectId);

    revalidatePath('/runtime/guard');
    return { ok: true, syncedTargets: 6 };
  } catch (err) {
    console.error('[simulateSampleTrafficAction] error:', err);
    return { ok: false, error: 'simulate_failed' };
  }
}

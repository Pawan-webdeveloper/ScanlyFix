'use server';

import { revalidatePath } from 'next/cache';

import {
  acknowledgeCanaryEvent,
  getProject,
  listCanaries,
  retireCanaries,
  seedCanaries,
} from '@scanlyfix/db';

import { requireUser } from '@/lib/authz';
import { hasRuntimeAccess } from '@/lib/entitlements';
import { runAnonAccessAudit, runCanaryCheck, type AnonAuditReport } from '@/lib/runtime/canaries/engine';
import { buildSetupScript } from '@/lib/runtime/canaries/setup-script';
import { SELFTEST_KIND } from '@/lib/runtime/canaries/types';
import { honeytokenOrigin } from '@/lib/runtime/canaries/origin';

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

class NotFoundError extends Error {
  constructor() {
    super('not_found');
    this.name = 'NotFoundError';
  }
}
class UpgradeRequiredError extends Error {
  constructor() {
    super('upgrade_required');
    this.name = 'UpgradeRequiredError';
  }
}

/**
 * Ownership AND entitlement, in one place.
 *
 * The Pro gate used to live only on the page component, which renders the
 * console. Every server action here was reachable regardless: a request to a
 * server action does not go through the page, so a user on any plan could
 * connect a database, generate decoys and run checks by calling them directly.
 * A gate that only exists in the UI is not a gate.
 */
async function assertAccess(projectId: string): Promise<void> {
  const user = await requireUser();
  const viewer = { kind: 'user' as const, userId: user.id };
  const project = await getProject(projectId, viewer);
  if (!project) throw new NotFoundError();
  if (!(await hasRuntimeAccess(viewer, projectId))) throw new UpgradeRequiredError();
}

/**
 * Turns a thrown error into a message the customer can act on.
 *
 * The console used to render whatever string came back, which meant people saw
 * `generate_failed` and `canaries_not_eligible_for_replant` in the UI. The real
 * error is logged server-side and never returned — a driver message can carry
 * connection details and table names.
 */
function toActionError(scope: string, err: unknown, fallback: string): string {
  console.error(`[${scope}] error:`, err);
  if (err instanceof NotFoundError) return 'That project could not be found.';
  if (err instanceof UpgradeRequiredError) return 'Canaries are a Pro feature. Upgrade to enable database intrusion detection.';
  return fallback;
}

function revalidateCanaries(): void {
  revalidatePath('/runtime/canaries');
}

/** Registers a fresh set of decoys and returns the SQL that plants them. */
async function plantFreshCanaries(projectId: string): Promise<{ sql: string; plantId: string }> {
  const { plantId, seeds, selfTest, sql } = buildSetupScript({ projectId, appDomain: honeytokenOrigin() });
  const rows = [...seeds.map((s) => ({ ...s })), { ...selfTest, kind: SELFTEST_KIND }];
  const inserted = await seedCanaries(projectId, rows);

  // A partial insert means some honeytoken paths in the SQL the customer is
  // about to paste were never stored, so hits on them would be discarded. That
  // has to be an error, not a silent shortfall.
  if (inserted !== rows.length) {
    throw new Error(`seedCanaries stored ${inserted} of ${rows.length} decoys for project ${projectId}`);
  }
  return { sql, plantId };
}

/** Generates the setup script and registers the decoy markers it will plant. */
export async function generateSetupScriptAction(projectId: string): Promise<ActionResult<{ sql: string }>> {
  try {
    await assertAccess(projectId);

    const existing = await listCanaries(projectId);
    const live = existing.filter((c) => c.status === 'planted' || c.status === 'compromised');
    if (live.length > 0) {
      return {
        ok: false,
        error: 'Decoys are already planted for this project. Use "Re-plant canaries" to replace them with a fresh set.',
      };
    }

    // Any leftover pending rows are from an abandoned attempt; retire them so
    // they cannot be confused with the set being generated now.
    if (existing.length > 0) await retireCanaries(projectId);

    const { sql } = await plantFreshCanaries(projectId);
    revalidateCanaries();
    return { ok: true, data: { sql } };
  } catch (err) {
    return { ok: false, error: toActionError('generateSetupScriptAction', err, 'The setup script could not be generated. Please try again.') };
  }
}

/**
 * Compromise recovery: retire the current decoys and issue a genuinely new set.
 *
 * This used to be a no-op. Markers were derived from the project id alone, so
 * every script produced the same three, and `seedCanaries` upserts with ON
 * CONFLICT DO NOTHING — the "fresh" rows collided with the retired ones and
 * were dropped. The project was then left with no live decoys at all, while the
 * SQL the customer pasted carried new honeytoken paths that matched nothing we
 * had stored. `buildSetupScript` now stamps each planting with its own id, and
 * `plantFreshCanaries` fails loudly rather than quietly if anything is dropped.
 */
export async function rePlantCanariesAction(projectId: string): Promise<ActionResult<{ sql: string }>> {
  try {
    await assertAccess(projectId);

    const existing = await listCanaries(projectId, { includeRetired: true });
    if (existing.length === 0) {
      return { ok: false, error: 'There is nothing to re-plant yet. Generate the setup script first.' };
    }

    await retireCanaries(projectId);
    const { sql } = await plantFreshCanaries(projectId);

    revalidateCanaries();
    return {
      ok: true,
      data: { sql },
      message: 'Fresh decoys registered. Run the SQL below in Supabase, then click "Verify setup" to set the new baseline.',
    };
  } catch (err) {
    return { ok: false, error: toActionError('rePlantCanariesAction', err, 'The decoys could not be re-planted. Please try again.') };
  }
}

/** Marks an event reviewed. Evidence is never deleted. */
export async function markEventReviewedAction(projectId: string, eventId: string): Promise<ActionResult> {
  try {
    await assertAccess(projectId);
    await acknowledgeCanaryEvent(projectId, eventId);
    revalidateCanaries();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toActionError('markEventReviewedAction', err, 'That event could not be marked as reviewed.') };
  }
}

export async function runCanaryCheckAction(projectId: string): Promise<ActionResult<{ detections: number; reachable: boolean }>> {
  try {
    await assertAccess(projectId);
    const summary = await runCanaryCheck(projectId);
    revalidateCanaries();
    return {
      ok: true,
      data: { detections: summary.detections.length, reachable: summary.reachable },
      message: !summary.reachable
        ? 'Supabase could not be reached, so nothing was verified.'
        : summary.detections.length === 0
          ? 'Check complete. No decoy row has been touched.'
          : `Check complete. ${summary.detections.length} new event${summary.detections.length === 1 ? '' : 's'} recorded.`,
    };
  } catch (err) {
    return { ok: false, error: toActionError('runCanaryCheckAction', err, 'The check could not be completed. Please try again.') };
  }
}

export async function runAnonAuditAction(projectId: string): Promise<ActionResult<AnonAuditReport>> {
  try {
    await assertAccess(projectId);
    const report = await runAnonAccessAudit(projectId);
    if (!report) {
      return {
        ok: false,
        error: 'The anon key is not connected, so an anonymous read test cannot be run. Add it from the connection panel.',
      };
    }
    revalidateCanaries();
    return { ok: true, data: report };
  } catch (err) {
    return { ok: false, error: toActionError('runAnonAuditAction', err, 'The anon-access audit could not be completed. Please try again.') };
  }
}

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
import { runAnonAccessAudit, runCanaryCheck } from '@/lib/runtime/canaries/engine';
import { buildSetupScript } from '@/lib/runtime/canaries/setup-script';

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

async function assertOwn(projectId: string): Promise<void> {
  const user = await requireUser();
  const project = await getProject(projectId, { kind: 'user', userId: user.id });
  if (!project) throw new Error('not_found');
}

/** Setup script generate — naye canary rows + markers humare DB me register hote hain. */
export async function generateSetupScriptAction(projectId: string): Promise<ActionResult<{ sql: string }>> {
  try {
    await assertOwn(projectId);
    const canaries = await listCanaries(projectId);
    if (canaries.length > 0 && canaries.every((c) => c.status !== 'pending_script')) {
      return { ok: false, error: 'canaries already planted — disconnect before regenerating' };
    }
    const appDomain = process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, '') ?? 'localhost:3000';
    const { seeds, sql } = buildSetupScript({ projectId, appDomain });
    await seedCanaries(projectId, seeds);
    return { ok: true, data: { sql } };
  } catch {
    return { ok: false, error: 'generate_failed' };
  }
}

/** Compromise recovery flow — retired old canaries, generates fresh markers/honeytokens. */
export async function rePlantCanariesAction(projectId: string): Promise<ActionResult<{ sql: string }>> {
  try {
    await assertOwn(projectId);
    const canaries = await listCanaries(projectId);
    if (canaries.length === 0) {
      return { ok: false, error: 'no_canaries_found' };
    }
    const hasEligible = canaries.some((c) => c.status === 'compromised' || c.status === 'planted');
    if (!hasEligible) {
      return { ok: false, error: 'canaries_not_eligible_for_replant' };
    }

    // 1) Mark old canary rows 'retired'
    await retireCanaries(projectId);

    // 2) Generate fresh setup script (new markers + honeytokens)
    const appDomain = process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, '') ?? 'localhost:3000';
    const { seeds, sql } = buildSetupScript({ projectId, appDomain });
    await seedCanaries(projectId, seeds);

    revalidatePath('/runtime/canaries');
    return { ok: true, data: { sql } };
  } catch {
    return { ok: false, error: 'replant_failed' };
  }
}

/** Mark an event as reviewed/acknowledged without deleting evidence. */
export async function markEventReviewedAction(projectId: string, eventId: string): Promise<ActionResult> {
  try {
    await assertOwn(projectId);
    await acknowledgeCanaryEvent(projectId, eventId);
    revalidatePath('/runtime/canaries');
    return { ok: true };
  } catch {
    return { ok: false, error: 'acknowledge_failed' };
  }
}

export async function runCanaryCheckAction(projectId: string): Promise<ActionResult<{ detections: number }>> {
  try {
    await assertOwn(projectId);
    const summary = await runCanaryCheck(projectId);
    revalidatePath('/runtime/canaries');
    return { ok: true, data: { detections: summary.detections.length } };
  } catch {
    return { ok: false, error: 'check_failed' };
  }
}

export async function runAnonAuditAction(projectId: string): Promise<ActionResult<{ readable: string[]; protectedCount: number }>> {
  try {
    await assertOwn(projectId);
    const report = await runAnonAccessAudit(projectId);
    if (!report) return { ok: false, error: 'Anon key is not connected' };
    revalidatePath('/runtime/canaries');
    return { ok: true, data: report };
  } catch {
    return { ok: false, error: 'audit_failed' };
  }
}
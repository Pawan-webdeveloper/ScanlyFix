'use server';

import { revalidatePath } from 'next/cache';

import { getRuntimeProjectContext, resolveFindingManually, getProject, getProjectOwnerEmail } from '@scanlyfix/db';
import { requireUser } from '@/lib/authz';
import { runAuthProber } from '@/lib/runtime/auth-prober';
import { buildProberAlertEmail } from '@/lib/runtime/auth-prober/alert';
import { sendEmail } from '@/lib/email';

export type ActionResult = { ok: true } | { ok: false; error: string };

async function assertOwnership(projectId: string): Promise<void> {
  const user = await requireUser();
  const project = await getProject(projectId, { kind: 'user', userId: user.id });
  if (!project) throw new Error('not_found');
}

/** "Record the baseline" / "Refresh" — dono isi se. */
export async function runProberAction(projectId: string): Promise<ActionResult> {
  try {
    await assertOwnership(projectId);
    const ctx = await getRuntimeProjectContext(projectId);
    if (!ctx?.isVerified) return { ok: false, error: 'verify_domain_first' };

    await runAuthProber(projectId, {
      onNewFindings: async (findings) => {
        const ownerEmail = await getProjectOwnerEmail(projectId);
        if (!ownerEmail) return;
        const email = buildProberAlertEmail({ projectUrl: ctx.hostname, findings });
        await sendEmail({ to: ownerEmail, ...email });
      },
    });
    revalidatePath(`/runtime`);
    revalidatePath(`/runtime/probers`);
    return { ok: true };
  } catch (err) {
    console.error('[runProberAction] error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'run_failed' };
  }
}

export async function resolveFindingAction(projectId: string, findingId: string): Promise<ActionResult> {
  try {
    await assertOwnership(projectId);
    await resolveFindingManually(findingId, projectId);
    revalidatePath(`/runtime`);
    revalidatePath(`/runtime/probers`);
    return { ok: true };
  } catch (err) {
    console.error('[resolveFindingAction] error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'resolve_failed' };
  }
}
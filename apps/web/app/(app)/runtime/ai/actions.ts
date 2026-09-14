'use server';

import { revalidatePath } from 'next/cache';

import { getProject, recordAiCallEvents, setSpendCeiling, type IngestAiCallEvent } from '@scanlyfix/db';

import { requireUser } from '@/lib/authz.ts';
import { hasRuntimeAccess } from '@/lib/entitlements.ts';
import { estimateServerCostMicroUsd } from '@/lib/runtime/ai-pricing/server-pricing.ts';
import { validateCeilingUsd } from '@/lib/runtime/ai-spend/ceiling.ts';
import { buildSampleCalls, isSampleScenario, type SampleScenario } from '@/lib/runtime/ai-spend/sample.ts';

export type AiActionResult = { ok: true; message?: string } | { ok: false; error: string };

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
 * Ownership and entitlement in one place, throwing rather than returning, so a
 * forgotten check cannot fall through into a write.
 */
async function assertAccess(projectId: string): Promise<{ userId: string }> {
  const user = await requireUser();
  const viewer = { kind: 'user' as const, userId: user.id };
  const project = await getProject(projectId, viewer);
  if (!project) throw new NotFoundError();
  if (!(await hasRuntimeAccess(viewer, projectId))) throw new UpgradeRequiredError();
  return { userId: user.id };
}

/**
 * Maps a thrown error to a stable code. The real error is logged server-side
 * and never returned: a driver message can carry connection details and table
 * names, none of which belong in a browser response.
 */
function toActionError(scope: string, err: unknown, fallback: string): string {
  console.error(`[${scope}] error:`, err);
  if (err instanceof NotFoundError) return 'not_found';
  if (err instanceof UpgradeRequiredError) return 'upgrade_required';
  return fallback;
}

function revalidateAi(): void {
  revalidatePath('/runtime/ai');
  revalidatePath('/runtime');
}

/**
 * Sets the hourly spend ceiling. The SDK firewall picks this up within five
 * minutes through /api/runtime/config and refuses calls before they reach the
 * provider — so this write is the one control that actually stops spend.
 */
export async function setCeilingAction(projectId: string, ceilingUsd: number): Promise<AiActionResult> {
  try {
    await assertAccess(projectId);

    const validated = validateCeilingUsd(ceilingUsd);
    if (!validated.ok) return { ok: false, error: validated.error };

    await setSpendCeiling(projectId, validated.microUsd);
    revalidateAi();
    return { ok: true, message: `Ceiling set to $${ceilingUsd}/hour. The SDK firewall picks it up within 5 minutes.` };
  } catch (err) {
    return { ok: false, error: toActionError('setCeilingAction', err, 'save_failed') };
  }
}

/** Removes the ceiling, falling back to baseline-relative alerting only. */
export async function clearCeilingAction(projectId: string): Promise<AiActionResult> {
  try {
    await assertAccess(projectId);
    await setSpendCeiling(projectId, null);
    revalidateAi();
    return { ok: true, message: 'Ceiling removed. Alerts now compare against this project’s own normal spend.' };
  } catch (err) {
    return { ok: false, error: toActionError('clearCeilingAction', err, 'save_failed') };
  }
}

/**
 * Seeds labelled demo telemetry so a new project can see what the console does.
 *
 * The scenario is chosen from a fixed set rather than accepted as free-form
 * input: the previous version took an arbitrary model string from the client
 * and wrote it straight into the calls table, and priced it with the SDK's
 * curated table instead of the server catalog that real ingest uses — so the
 * demo could disagree with production for the same model.
 */
export async function sendSampleAiCallAction(projectId: string, scenario: string = 'mixed'): Promise<AiActionResult> {
  try {
    await assertAccess(projectId);

    const chosen: SampleScenario = isSampleScenario(scenario) ? scenario : 'mixed';
    const specs = buildSampleCalls(chosen);

    const events: IngestAiCallEvent[] = await Promise.all(
      specs.map(async (spec) => ({
        provider: spec.provider,
        model: spec.model,
        promptTokens: spec.promptTokens,
        completionTokens: spec.completionTokens,
        latencyMs: spec.latencyMs,
        // Same pricing path as real ingest, so the demo cannot disagree with production.
        costMicroUsd: spec.status === 'error' ? 0 : await estimateServerCostMicroUsd(spec.model, spec.promptTokens, spec.completionTokens),
        userHash: spec.userHash,
        source: 'sample',
        status: spec.status,
        errorKind: spec.errorKind,
      })),
    );

    await recordAiCallEvents(projectId, events);
    revalidateAi();
    return { ok: true, message: `Seeded ${events.length} sample calls. They are labelled and excluded from every spend total.` };
  } catch (err) {
    return { ok: false, error: toActionError('sendSampleAiCallAction', err, 'sample_failed') };
  }
}

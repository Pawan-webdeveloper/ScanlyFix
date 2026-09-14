import { getProjectOwnerEmail, getRuntimeProjectContext, listCanaryEligibleProjectIds } from '@scanlyfix/db';

import { sendEmail } from '../../lib/email.ts';
import { inngest } from '../../lib/inngest.ts';
import { buildCanaryAlertEmail } from '../../lib/runtime/canaries/alert.ts';
import { runCanaryCheck } from '../../lib/runtime/canaries/index.ts';
import type { CanaryDetection } from '../../lib/runtime/canaries/types.ts';

/**
 * Ceiling on projects checked in one nightly run.
 *
 * Each project costs several outbound HTTP requests to someone else's database,
 * and `restSelect` retries a waking-up Supabase project for up to ~33 seconds.
 * An unbounded serial sweep over a large fleet would still be running when the
 * next night's run started.
 */
export const MAX_PROJECTS_PER_RUN = 200;

function dashboardUrl(projectId: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  return base ? `${base}/runtime/canaries?projectId=${projectId}` : null;
}

/**
 * Nightly canary check — 02:30 UTC, away from the 02:00 prober so the two do
 * not contend.
 *
 * The check and the alert are separate steps on purpose. They used to be one:
 * `runCanaryCheck` wrote the event rows and then the same step sent the email,
 * so a transient mail failure retried the whole step — and the second run found
 * its own freshly written rows, suppressed them as duplicates, and returned
 * nothing to alert on. A real intrusion could be recorded and never sent.
 * Inngest memoises a completed step, so splitting them means a retry re-sends
 * the mail with the detections already in hand.
 */
export const runtimeCanaryCheck = inngest.createFunction(
  { id: 'runtime/canary-nightly', triggers: [{ cron: 'TZ=UTC 30 2 * * *' }], concurrency: { limit: 1 }, retries: 2 },
  async ({ step, logger }) => {
    const projectIds = await step.run('list-eligible', listCanaryEligibleProjectIds);
    const bounded = projectIds.slice(0, MAX_PROJECTS_PER_RUN);
    if (bounded.length < projectIds.length) {
      // Never let a cap look like a completed sweep.
      logger.warn('canary: project cap reached, remainder not checked this run', {
        checked: bounded.length,
        skipped: projectIds.length - bounded.length,
      });
    }
    logger.info('canary: eligible projects', { count: bounded.length });

    let alerted = 0;
    let failed = 0;

    for (const projectId of bounded) {
      try {
        const detections = (await step.run(`check:${projectId}`, async () => {
          const summary = await runCanaryCheck(projectId);
          return summary.detections;
        })) as CanaryDetection[];

        if (detections.length === 0) continue;

        await step.run(`alert:${projectId}`, async () => {
          const [ownerEmail, ctx] = await Promise.all([
            getProjectOwnerEmail(projectId),
            getRuntimeProjectContext(projectId),
          ]);
          if (!ownerEmail) return { sent: false, reason: 'no_owner_email' };

          const email = buildCanaryAlertEmail({
            hostname: ctx?.hostname ?? projectId,
            detections,
            dashboardUrl: dashboardUrl(projectId),
          });
          await sendEmail({ to: ownerEmail, ...email });
          return { sent: true };
        });
        alerted++;
      } catch (err) {
        // One project's database being unreachable, or one mail send failing
        // after its retries, must not stop every project after it in the list.
        failed++;
        logger.error('canary: project check failed', { projectId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { checked: bounded.length, alerted, failed, skipped: projectIds.length - bounded.length };
  },
);

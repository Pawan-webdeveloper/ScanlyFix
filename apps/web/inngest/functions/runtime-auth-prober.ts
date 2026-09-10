import {
  getProjectOwnerEmail,
  getRuntimeProjectContext,
  listProberEligibleProjectIds,
} from '@scanlyfix/db';

import { inngest } from '../../lib/inngest.ts';
import { sendEmail } from '../../lib/email.ts';
import { runAuthProber } from '../../lib/runtime/auth-prober/index.ts';
import { buildProberAlertEmail, summarizeRun } from '../../lib/runtime/auth-prober/alert.ts';
import { syncGuardRoutesToProber } from '../../lib/runtime/guard/sync.ts'; // ⭐ PATCH 1: nayi import

/**
 * Nightly auth prober — CheckVibe jaisa: roz raat 02:00 UTC.
 * Sirf wahi projects jinke paas (a) verified domain aur (b) recorded baseline hai.
 */
export const runtimeAuthProber = inngest.createFunction(
  {
    id: 'runtime/auth-prober-nightly',
    triggers: [{ cron: 'TZ=UTC 0 2 * * *' }],
    concurrency: { limit: 1 },
    retries: 2,
  },
  async ({ step, logger }) => {
    const projectIds = await step.run('list-eligible-projects', listProberEligibleProjectIds);
    logger.info('auth-prober: eligible projects', { count: projectIds.length });

    const results: string[] = [];

    for (const projectId of projectIds) {
      // ⭐ PATCH 2: Guard ke real routes se prober targets refresh (guesses → reality).
      // probe step se PEHLE chale, taaki is raat ke probe me hi naye routes cover hon.
      // Sync fail ho to prober phir bhi chale — telemetry kisi ko rokti nahi.
      await step.run(`sync-guard:${projectId}`, async () => {
        try {
          const result = await syncGuardRoutesToProber(projectId);
          if (result.synced > 0) {
            logger.info('auth-prober: guard sync', { projectId, synced: result.synced });
          }
          return result;
        } catch (error) {
          logger.warn('auth-prober: guard sync failed, prober will use existing targets', {
            projectId,
            error,
          });
          return { synced: 0, candidates: 0 };
        }
      });

      const summary = await step.run(`probe:${projectId}`, async () =>
        runAuthProber(projectId, {
          onNewFindings: async (findings) => {
            const [ownerEmail, projectCtx] = await Promise.all([
              getProjectOwnerEmail(projectId),
              getRuntimeProjectContext(projectId),
            ]);
            if (!ownerEmail) {
              logger.warn('auth-prober: no owner email found', { projectId });
              return;
            }
            const email = buildProberAlertEmail({
              projectUrl: projectCtx?.hostname ?? projectId,
              findings,
            });
            await sendEmail({ to: ownerEmail, ...email });
          },
        }),
      );
      results.push(`${projectId} → ${summarizeRun(summary)}`);
    }

    return { runs: results };
  },
);
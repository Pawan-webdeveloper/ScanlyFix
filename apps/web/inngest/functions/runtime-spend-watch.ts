import {
  claimSpendAlertHour,
  getProjectOwnerEmail,
  getRuntimeProjectContext,
  getSpendBaselineMicroUsd,
  getSpendBreakdown,
  getSpendCeilingMicroUsd,
  getSpendWindowMicroUsd,
  listSpendWatchProjectIds,
} from '@scanlyfix/db';

import { sendEmail } from '../../lib/email.ts';
import { inngest } from '../../lib/inngest.ts';
import { buildSpendAlertEmail } from '../../lib/runtime/ai-spend/alert.ts';
import { evaluateVelocity } from '../../lib/runtime/ai-spend/velocity.ts';

/** The live window the projection is extrapolated from. */
export const SPEND_WINDOW_MINUTES = 15;

/**
 * How far back the watch list looks for activity. Wider than the five-minute
 * cron so a project is never dropped between two runs.
 */
export const WATCH_LOOKBACK_MINUTES = 30;

/** Guard against a fleet-wide incident turning into a fleet-wide mailshot in one run. */
export const MAX_PROJECTS_PER_RUN = 200;

function dashboardUrl(projectId: string): string | null {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
  return base ? `${base}/runtime/ai?projectId=${projectId}` : null;
}

/**
 * VELOCITY WATCH — every 5 minutes, projecting from a 15-minute live window so
 * a runaway loop is caught in minutes rather than at the end of the hour.
 *
 * Two things keep this cheap. The watch list now contains only projects that
 * actually spent something recently, instead of every project in the database;
 * and each project's queries are issued together rather than one step at a
 * time. Deduplication stays where it was — `claimSpendAlertHour` has a unique
 * constraint on (project, hour), so one hour produces one email no matter how
 * many times this runs or how many workers race.
 */
export const runtimeSpendWatch = inngest.createFunction(
  { id: 'runtime/spend-watch', triggers: [{ cron: 'TZ=UTC */5 * * * *' }], concurrency: { limit: 1 }, retries: 1 },
  async ({ step, logger }) => {
    const projectIds = await step.run('list-active-projects', () => listSpendWatchProjectIds(WATCH_LOOKBACK_MINUTES));

    if (projectIds.length === 0) return { watched: 0, alerted: 0 };
    const bounded = projectIds.slice(0, MAX_PROJECTS_PER_RUN);
    logger.info('spend-watch: active projects', { count: bounded.length, truncated: projectIds.length - bounded.length });

    let alerted = 0;

    for (const projectId of bounded) {
      const outcome = await step.run(`watch:${projectId}`, async () => {
        const [windowMicro, ceilingMicro, baselineMicro] = await Promise.all([
          getSpendWindowMicroUsd(projectId, SPEND_WINDOW_MINUTES),
          getSpendCeilingMicroUsd(projectId),
          getSpendBaselineMicroUsd(projectId),
        ]);

        const verdict = evaluateVelocity({
          windowMicroUsd: windowMicro,
          windowMinutes: SPEND_WINDOW_MINUTES,
          ceilingMicroUsd: ceilingMicro,
          baselineMicroUsd: baselineMicro,
        });
        if (!verdict.shouldAlert) return 'ok';

        // Claim BEFORE doing any more work: whoever wins the insert sends the
        // one email this hour gets, and the loser stops here.
        const hourDate = new Date();
        hourDate.setUTCMinutes(0, 0, 0);
        const claimed = await claimSpendAlertHour(projectId, hourDate, windowMicro, verdict.projectedHourlyMicroUsd);
        if (!claimed) return 'already-alerted-this-hour';

        const [ownerEmail, ctx, breakdown] = await Promise.all([
          getProjectOwnerEmail(projectId),
          getRuntimeProjectContext(projectId),
          // The alert has to say WHAT is spending it; that is the whole point.
          getSpendBreakdown(projectId, SPEND_WINDOW_MINUTES),
        ]);
        if (!ownerEmail) return 'no-email';

        const email = buildSpendAlertEmail({
          projectLabel: ctx?.hostname ?? projectId,
          verdict,
          windowMicroUsd: windowMicro,
          windowMinutes: SPEND_WINDOW_MINUTES,
          ceilingMicroUsd: ceilingMicro,
          baselineMicroUsd: baselineMicro,
          topModels: breakdown.byModel,
          topUsers: breakdown.byUser,
          dashboardUrl: dashboardUrl(projectId),
        });

        await sendEmail({ to: ownerEmail, ...email });
        logger.info('spend-watch: alert sent', {
          projectId,
          reason: verdict.reason,
          severity: verdict.severity,
          pctOfCeiling: verdict.pctOfCeiling,
          baselineMultiple: verdict.baselineMultiple,
        });
        return 'alerted';
      });

      if (outcome === 'alerted') alerted++;
    }

    return { watched: bounded.length, alerted };
  },
);

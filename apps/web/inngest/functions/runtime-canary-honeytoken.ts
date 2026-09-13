import {
  countRecentHoneytokenHits,
  getProjectOwnerEmail,
  getRuntimeProjectContext,
} from '@scanlyfix/db';

import { inngest, EVENTS } from '../../lib/inngest.ts';
import { sendEmail } from '../../lib/email.ts';
import { buildCanaryAlertEmail } from '../../lib/runtime/canaries/alert.ts';

/**
 * Instant honeytoken hit alert worker.
 * Fires immediately when an attacker / crawler hits a honeytoken URL.
 * Rate limits emails to max 1 email per honeytoken per hour.
 */
export const runtimeCanaryHoneytokenAlert = inngest.createFunction(
  {
    id: 'runtime/canary-honeytoken-alert',
    triggers: [{ event: EVENTS.canaryHoneytokenHit }],
    concurrency: { key: 'event.data.canaryId', limit: 1 },
    retries: 2,
  },
  async ({ event, step, logger }) => {
    const { projectId, canaryId, detail } = event.data;

    // Rate-limit the email: max 1 email per honeytoken per hour.
    const recentHits = await step.run('check-rate-limit', async () => {
      return countRecentHoneytokenHits(canaryId, 60);
    });

    if (recentHits > 1) {
      logger.info('honeytoken alert rate-limited (already alerted within 1 hour)', {
        canaryId,
        recentHits,
      });
      return { alerted: false, reason: 'rate_limited', recentHits };
    }

    const [ownerEmail, ctx] = await Promise.all([
      getProjectOwnerEmail(projectId),
      getRuntimeProjectContext(projectId),
    ]);

    if (!ownerEmail) {
      logger.warn('honeytoken alert skipped: no owner email found', { projectId });
      return { alerted: false, reason: 'no_owner_email' };
    }

    await step.run('send-alert-email', async () => {
      const email = buildCanaryAlertEmail({
        hostname: ctx?.hostname ?? projectId,
        detections: [
          {
            kind: 'honeytoken_hit',
            source: 'honeytoken',
            canaryId,
            detail: detail ?? 'Honeytoken accessed — extracted data in use',
          },
        ],
      });
      await sendEmail({ to: ownerEmail, ...email });
    });

    return { alerted: true, to: ownerEmail };
  },
);

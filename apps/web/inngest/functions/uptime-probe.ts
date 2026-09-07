/**
 * FILE: apps/web/inngest/functions/uptime-probe.ts
 *
 * Inngest wrapper for uptime monitoring.
 * Delegates the actual probe, recording, and alert dispatch to `executeUptimeProbe`
 * in `apps/web/lib/uptime-probe-core.ts`.
 */

import { inngest, EVENTS } from '@/lib/inngest.ts'
import { executeUptimeProbe } from '@/lib/uptime-probe-core.ts'
import type { MonitorDueEvent } from './types.ts'

export const uptimeProbe = inngest.createFunction(
  {
    id: 'monitor-uptime',
    triggers: [{ event: EVENTS.monitorDue, if: 'event.data.type == "uptime"' }],
    concurrency: { limit: 20 },
    retries: 0,
  },
  async ({ event, step }) => {
    const { monitorId, projectId, url } = event.data as MonitorDueEvent['data']

    // Validate URL format before proceeding
    try {
      new URL(url)
    } catch {
      return { ok: false, error: 'unparseable project URL' }
    }

    return await step.run('execute-probe', () =>
      executeUptimeProbe({ monitorId, projectId, url }),
    )
  },
)
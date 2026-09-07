/**
 * POST /api/monitors/[id]/run
 *
 * Manual run trigger — called when the user clicks "Run check" or "Refresh"
 * on the monitor page.
 *
 * It dispatches the `monitorDue` event to Inngest (for queue observability and workers),
 * and for uptime monitors, it ALSO runs `executeUptimeProbe` directly so the caller
 * gets instantaneous database updates and alert email delivery.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db, getProject, monitors } from '@scanlyfix/db'
import { eq } from 'drizzle-orm'
import { inngest, EVENTS } from '@/lib/inngest.ts'
import { getViewer } from '@/lib/authz.ts'
import { executeUptimeProbe } from '@/lib/uptime-probe-core.ts'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid monitor ID' }, { status: 400 })
  }

  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, id),
    columns: { id: true, type: true, enabled: true, projectId: true },
  })

  if (!monitor) {
    return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
  }

  const project = await getProject(monitor.projectId, viewer)
  if (!project) {
    return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
  }

  // 1. Dispatch event to Inngest queue
  try {
    await inngest.send({
      name: EVENTS.monitorDue,
      data: {
        monitorId: monitor.id,
        type: monitor.type,
        projectId: project.id,
        url: project.url,
        triggeredBy: 'manual',
      },
    })
  } catch (error) {
    console.error(`[api/monitors/run] Failed to dispatch monitor ${monitor.id}:`, error)
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV !== 'production'
            ? 'Background queue is unreachable. In development, please make sure Inngest Dev Server is running (`npx inngest-cli@latest dev`).'
            : 'The background queue is currently unavailable. Please try again later.',
      },
      { status: 500 },
    )
  }

  // 2. For uptime monitors: run the probe immediately so user sees live update without waiting for queue lag
  if (monitor.type === 'uptime') {
    try {
      await executeUptimeProbe({
        monitorId: monitor.id,
        projectId: project.id,
        url: project.url,
      })
    } catch (probeErr) {
      console.warn(`[api/monitors/run] Immediate probe execution skipped or failed:`, probeErr)
    }
  }

  return NextResponse.json({ ok: true, monitorId: monitor.id })
}

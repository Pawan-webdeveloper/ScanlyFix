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

  // 1. For uptime monitors: run the probe immediately so user sees live update without waiting for queue lag
  let immediateProbeRan = false
  if (monitor.type === 'uptime') {
    try {
      await executeUptimeProbe({
        monitorId: monitor.id,
        projectId: project.id,
        url: project.url,
      })
      immediateProbeRan = true
    } catch (probeErr) {
      console.warn(`[api/monitors/run] Immediate probe execution skipped or failed:`, probeErr)
    }
  }

  // 2. Dispatch event to Inngest queue (for queue observability and background workers)
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
    console.warn(`[api/monitors/run] Inngest dispatch failed for monitor ${monitor.id}:`, error)
    // If the monitor probe didn't run immediately (e.g. non-uptime monitor or probe failure), return 500
    if (!immediateProbeRan) {
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
  }

  return NextResponse.json({ ok: true, monitorId: monitor.id })
}

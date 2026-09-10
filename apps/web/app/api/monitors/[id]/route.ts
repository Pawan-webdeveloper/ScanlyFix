/**
 * GET /api/monitors/[id]
 *
 * Returns the live state of a single monitor: last status, the latest
 * event's HTTP status code, latency, and detail string. Designed for the
 * monitor detail page to poll so the status code (200/503/404/etc.) and
 * the up/down pill update without a manual page reload.
 *
 * If the monitor is due for a check (never run or older than intervalS)
 * and enabled, it executes a live probe so active viewers always see
 * fresh, accurate health metrics even if background queue workers are idle.
 */

import { NextResponse } from 'next/server'
import { listMonitorsForUser } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import { executeUptimeProbe } from '@/lib/uptime-probe-core.ts'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  if (!UUID.test(id)) {
    return NextResponse.json({ error: 'Invalid monitor ID' }, { status: 400 })
  }

  try {
    let monitors = await listMonitorsForUser(viewer)
    let monitor = monitors.find((m) => m.id === id)
    if (!monitor) {
      return NextResponse.json({ error: 'Monitor not found' }, { status: 404 })
    }

    // Auto-probe if monitor is due OR if monitor is marked down and >=15s have elapsed since last check
    const timeSinceLastRun = monitor.lastRunAt
      ? Date.now() - monitor.lastRunAt.getTime()
      : Infinity
    const isDue =
      monitor.enabled &&
      monitor.type === 'uptime' &&
      (!monitor.lastRunAt ||
        timeSinceLastRun >= monitor.intervalS * 1000 ||
        (monitor.lastStatus === 'down' && timeSinceLastRun >= 15_000))

    if (isDue) {
      try {
        await executeUptimeProbe({
          monitorId: monitor.id,
          projectId: monitor.projectId,
          url: monitor.projectUrl,
        })
        monitors = await listMonitorsForUser(viewer)
        monitor = monitors.find((m) => m.id === id) ?? monitor
      } catch (probeErr) {
        console.warn(`[api/monitors/${id}] Auto-probe on read failed:`, probeErr)
      }
    }

    return NextResponse.json({
      monitor: {
        id: monitor.id,
        type: monitor.type,
        enabled: monitor.enabled,
        lastStatus: monitor.lastStatus,
        lastRunAt: monitor.lastRunAt?.toISOString() ?? null,
        lastStatusCode: monitor.lastStatusCode,
        lastLatencyMs: monitor.lastLatencyMs,
        lastDetail: monitor.lastDetail,
        intervalS: monitor.intervalS,
        projectName: monitor.projectName,
        projectUrl: monitor.projectUrl,
        isStale: monitor.isStale,
      },
    })
  } catch (error) {
    console.error(`[api/monitors/${id}] failed to fetch monitor:`, error)
    return NextResponse.json({ error: 'Failed to fetch monitor' }, { status: 500 })
  }
}
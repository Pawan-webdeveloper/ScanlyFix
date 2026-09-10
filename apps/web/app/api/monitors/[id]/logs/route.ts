/**
 * GET /api/monitors/[id]/logs
 *
 * Last N check events for a monitor with diff from previous check.
 * Used to render the check history table with change indicators.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { recentEventsWithDiff } from '@scanlyfix/db'
import { getViewer } from '@/lib/authz.ts'
import type { MonitorLogsResponse } from '@scanlyfix/db/types/monitor-diff.ts'

// ─── Query params schema ───────────────────────────────────────────────────────
// WHY Zod validate: URL params string hote hain — safely parse aur clamp karo
const QuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? parseInt(v, 10) : 50
      if (isNaN(n) || n < 1) return 50
      return Math.min(n, 5000)
    }),
})

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const viewer = await getViewer()
  if (viewer.kind !== 'user') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Validate monitorId ─────────────────────────────────────────────────
  // WHY: params.id directly use mat karo — basic UUID check
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid monitor ID' }, { status: 400 })
  }

  // ── 3. Parse query params ─────────────────────────────────────────────────
  const { searchParams } = new URL(req.url)
  const queryParsed = QuerySchema.safeParse({
    limit: searchParams.get('limit') ?? undefined,
  })

  if (!queryParsed.success) {
    return NextResponse.json(
      { error: 'Invalid query params', issues: queryParsed.error.issues },
      { status: 400 },
    )
  }

  // ── 4. Fetch logs ─────────────────────────────────────────────────────────
  // WHY try-catch: DB errors user ko 500 de sakti hain — gracefully handle
  try {
    const logs = await recentEventsWithDiff(
      id,
      viewer,
      queryParsed.data.limit,
    )

    const response: MonitorLogsResponse = { logs }
    return NextResponse.json(response)
  } catch (err) {
    console.error('[monitor-logs] Failed to fetch logs:', err)
    return NextResponse.json(
      { error: 'Failed to fetch logs' },
      { status: 500 },
    )
  }
}

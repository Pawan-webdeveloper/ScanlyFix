import { NextResponse, type NextRequest } from 'next/server';
import { recordRouteEvents, type IngestRouteEvent } from '@scanlyfix/db';

export async function POST(req: NextRequest) {
  try {
    const projectId =
      req.headers.get('x-runtime-project-id') ??
      req.nextUrl.searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json({ ok: false, error: 'missing_project_id' }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as { events?: IngestRouteEvent[] } | null;
    if (!body || !Array.isArray(body.events)) {
      return NextResponse.json({ ok: false, error: 'invalid_payload' }, { status: 400 });
    }

    const recorded = await recordRouteEvents(projectId, body.events);

    return NextResponse.json({ ok: true, recorded });
  } catch (err) {
    console.error('[runtime/ingest] error:', err);
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}

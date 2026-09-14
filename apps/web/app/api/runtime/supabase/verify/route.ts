import { NextResponse } from 'next/server';

import { getCanaryProjectConfig, listCanaries, markCanariesSetup } from '@scanlyfix/db';

import { getViewer } from '@/lib/authz';
import { hasRuntimeAccess } from '@/lib/entitlements';
import { getProject } from '@scanlyfix/db';
import { decryptValue } from '@/lib/header-encryption';
import { sha256Canonical } from '@/lib/runtime/canaries/integrity';
import { restSelect } from '@/lib/runtime/canaries/supabase-rest';
import { CANARY_LOG_TABLE, CANARY_TABLE } from '@/lib/runtime/canaries/types';

/** User SQL run karke aaya — service key se vault table dikh rahi? Markers match? Snapshot le lo. */
export async function POST(req: Request): Promise<NextResponse> {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!projectId) return NextResponse.json({ ok: false, error: 'Missing projectId' }, { status: 400 });

  const project = await getProject(projectId, viewer);
  if (!project) return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });

  // Enforced here as well as on the page: a server route that reads a customer's
  // database must not rely on the UI having gated it.
  if (!(await hasRuntimeAccess(viewer, projectId))) {
    return NextResponse.json({ ok: false, error: 'Canaries are a Pro feature.' }, { status: 403 });
  }

  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  if (!cfg) return NextResponse.json({ ok: false, error: 'Please connect your Supabase database first in Step 1.' }, { status: 400 });

  const rest = { url: cfg.supabaseUrl, serviceKey: cfg.serviceKey };
  const rows = await restSelect<{ marker: string; payload: unknown }>(rest, CANARY_TABLE, { query: 'select=marker,payload' });

  // 1) Missing Table / PostgREST schema cache miss
  const isMissingTable =
    rows.status === 404 ||
    (rows.status === 400 && (
      rows.error?.includes('PGRST200') ||
      rows.error?.includes('42P01') ||
      rows.error?.toLowerCase().includes('schema cache') ||
      rows.error?.toLowerCase().includes('does not exist')
    ));

  if (isMissingTable) {
    return NextResponse.json(
      {
        ok: false,
        error: `Decoy table '${CANARY_TABLE}' was not found in Supabase. Please make sure you pasted and ran the setup SQL in your Supabase SQL Editor, then click Verify again.`,
      },
      { status: 400 },
    );
  }

  // 2) Supabase Service Key rejected (401/403)
  if (rows.status === 401 || rows.status === 403) {
    return NextResponse.json(
      {
        ok: false,
        error: `Supabase rejected the service role key (HTTP ${rows.status}). Please check that your Service Role Secret Key has service_role privileges.`,
      },
      { status: 400 },
    );
  }

  // 3) Supabase Gateway / Project Paused / Down (502, 503, 504)
  if (rows.status === 502 || rows.status === 503 || rows.status === 504) {
    return NextResponse.json(
      {
        ok: false,
        error: `Supabase instance returned HTTP ${rows.status}. If your Supabase project was paused or is waking up, wait 30 seconds and retry.`,
      },
      { status: 502 },
    );
  }

  // 4) Network or DNS resolution failure
  if (rows.status === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Supabase at ${cfg.supabaseUrl} did not answer. Check that the project URL is right and that the project is not paused.`,
      },
      { status: 502 },
    );
  }

  // 5) Generic REST failure. `restSelect` has already logged the driver's own
  // message, which can carry table names and connection details; what goes back
  // to the browser is only the status and what to do about it.
  if (!rows.ok || !rows.data) {
    return NextResponse.json(
      {
        ok: false,
        error: `Supabase answered with HTTP ${rows.status}. Wait a moment and click Verify again; if it keeps failing, re-check the project URL and service role key.`,
      },
      { status: 502 },
    );
  }

  // 6) Match canaries
  const canaries = await listCanaries(projectId);
  if (canaries.length === 0) {
    // An empty list used to pass: nothing was missing because nothing was
    // expected, so verification reported success on a project with no decoys
    // registered at all.
    return NextResponse.json(
      {
        ok: false,
        error: 'No decoys are registered for this project. Generate the setup script first, run it, then verify.',
      },
      { status: 400 },
    );
  }
  const found = new Set(rows.data.map((r) => r.marker));
  const missing = canaries.filter((c) => !found.has(c.markerToken));
  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Canary markers missing in table: ${missing.map((m) => m.markerToken).join(', ')}. Please run the generated SQL script to insert the decoy rows.`,
      },
      { status: 400 },
    );
  }

  // 7) Read the trigger log: its size, and the id everything up to now sits at.
  const [log, newestLog] = await Promise.all([
    restSelect<{ id: number }>(rest, CANARY_LOG_TABLE, { query: 'select=id', withCount: true }),
    restSelect<{ id: number }>(rest, CANARY_LOG_TABLE, { query: 'select=id&order=id.desc', limit: 1 }),
  ]);

  // 8) Baseline snapshot
  const payloadHashes: Record<string, string> = {};
  for (const r of rows.data) {
    payloadHashes[r.marker] = sha256Canonical(r.payload);
  }

  // The watermark starts at whatever the log already holds. Without it, the
  // first nightly check after setup would report every pre-existing log row as
  // a fresh intrusion.
  const lastLogId = newestLog.data?.[0]?.id ?? 0;

  await markCanariesSetup(projectId, {
    payloadHashes,
    logRowCount: log.count ?? 0,
    lastLogId,
    takenAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, rows: rows.data.length });
}
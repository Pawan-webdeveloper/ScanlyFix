import { NextResponse } from 'next/server';

import { getCanaryProjectConfig, listCanaries, markCanariesSetup } from '@scanlyfix/db';

import { getViewer } from '@/lib/authz';
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

  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  if (!cfg) return NextResponse.json({ ok: false, error: 'Please connect your Supabase database first in Step 1.' }, { status: 400 });

  const rest = { url: cfg.supabaseUrl, serviceKey: cfg.serviceKey };
  console.log(`[POST /api/runtime/supabase/verify] Verifying Supabase connection for project ${projectId} at ${cfg.supabaseUrl}...`);

  const rows = await restSelect<{ marker: string; payload: unknown }>(rest, CANARY_TABLE, { query: 'select=marker,payload' });
  console.log(`[POST /api/runtime/supabase/verify] CANARY_TABLE query response: status=${rows.status}, ok=${rows.ok}, error=${rows.error || 'none'}, rowsCount=${rows.data?.length ?? 'null'}`);

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
        error: `Unable to connect to Supabase at ${cfg.supabaseUrl} (${rows.error || 'Connection failed'}). Check the project URL.`,
      },
      { status: 502 },
    );
  }

  // 5) Generic REST failure
  if (!rows.ok || !rows.data) {
    return NextResponse.json(
      {
        ok: false,
        error: `Supabase REST API returned error (${rows.status}): ${rows.error || 'Unknown error'}`,
      },
      { status: 502 },
    );
  }

  // 6) Match canaries
  const canaries = await listCanaries(projectId);
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

  // 7) Query log table
  const log = await restSelect<{ id: number }>(rest, CANARY_LOG_TABLE, { query: 'select=id', withCount: true });
  console.log(`[POST /api/runtime/supabase/verify] CANARY_LOG_TABLE count: ${log.count ?? 0}`);

  // 8) Baseline snapshot mirror
  const payloadHashes: Record<string, string> = {};
  for (const r of rows.data) {
    payloadHashes[r.marker] = sha256Canonical(r.payload);
  }

  await markCanariesSetup(projectId, {
    payloadHashes,
    logRowCount: log.count ?? 0,
    takenAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, rows: rows.data.length });
}
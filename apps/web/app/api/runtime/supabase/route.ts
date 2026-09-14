import { NextResponse } from 'next/server';

import { clearSupabaseConnection, retireCanaries, saveSupabaseConnection } from '@scanlyfix/db';

import { getViewer } from '@/lib/authz';
import { hasRuntimeAccess } from '@/lib/entitlements';
import { getProject } from '@scanlyfix/db';
import { encryptValue } from '@/lib/header-encryption';
import { isValidSupabaseUrl, restSelect, validateAnonKey, validateServiceKey } from '@/lib/runtime/canaries/supabase-rest';
import { CANARY_TABLE } from '@/lib/runtime/canaries/types';

export async function POST(req: Request): Promise<NextResponse> {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') return NextResponse.json({ ok: false }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { projectId?: string; url?: string; serviceKey?: string; anonKey?: string }
    | null;
  if (!body?.projectId || !body.url || !body.serviceKey) {
    return NextResponse.json(
      { ok: false, error: 'A project, a Supabase URL and a service role key are all required.' },
      { status: 400 },
    );
  }

  const project = await getProject(body.projectId, viewer);
  if (!project) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  // The Pro gate used to exist only on the page component. This route stores a
  // customer's service role key and is reachable directly, so it enforces the
  // entitlement itself.
  if (!(await hasRuntimeAccess(viewer, body.projectId))) {
    return NextResponse.json({ ok: false, error: 'Canaries are a Pro feature.' }, { status: 403 });
  }

  if (!isValidSupabaseUrl(body.url)) {
    return NextResponse.json(
      { ok: false, error: 'The project URL must look like https://your-ref.supabase.co' },
      { status: 400 },
    );
  }
  const keyCheck = validateServiceKey(body.serviceKey);
  if (!keyCheck.valid) {
    return NextResponse.json({ ok: false, error: keyCheck.error }, { status: 400 });
  }
  if (body.anonKey) {
    const anonCheck = validateAnonKey(body.anonKey);
    if (!anonCheck.valid) {
      return NextResponse.json({ ok: false, error: anonCheck.error }, { status: 400 });
    }
  }

  // Live validation: service key se vault table (ya koi bhi) select — 401/403 = galat key
  const probe = await restSelect({ url: body.url, serviceKey: body.serviceKey }, CANARY_TABLE, { limit: 1 });
  if (probe.status === 401 || probe.status === 403) {
    return NextResponse.json(
      { ok: false, error: `Supabase rejected that service role key (HTTP ${probe.status}). Copy it again from Project Settings → API.` },
      { status: 400 },
    );
  }
  // 404 = table abhi nahi (setup pending) — connection phir bhi theek hai

  try {
    await saveSupabaseConnection(
      body.projectId,
      body.url,
      encryptValue(body.serviceKey),
      body.anonKey ? encryptValue(body.anonKey) : null,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/runtime/supabase] Encryption or DB save failed:', err);
    return NextResponse.json({ ok: false, error: 'The connection could not be saved. Please try again.' }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') return NextResponse.json({ ok: false }, { status: 401 });
  const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!projectId) return NextResponse.json({ ok: false }, { status: 400 });
  const project = await getProject(projectId, viewer);
  if (!project) return NextResponse.json({ ok: false }, { status: 404 });
  // Retire the decoys too. Leaving them at 'planted' with no connection left the
  // dashboard claiming live monitoring, and blocked regeneration with a message
  // telling the customer to disconnect — which they just had.
  await Promise.all([clearSupabaseConnection(projectId), retireCanaries(projectId)]);
  return NextResponse.json({ ok: true });
}
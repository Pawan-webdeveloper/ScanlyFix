import { NextResponse } from 'next/server';

import { clearSupabaseConnection, saveSupabaseConnection } from '@scanlyfix/db';

import { getViewer } from '@/lib/authz';
import { getProject } from '@scanlyfix/db';
import { encryptValue } from '@/lib/header-encryption';
import { isValidSupabaseUrl, restSelect, validateServiceKey } from '@/lib/runtime/canaries/supabase-rest';
import { CANARY_TABLE } from '@/lib/runtime/canaries/types';

export async function POST(req: Request): Promise<NextResponse> {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') return NextResponse.json({ ok: false }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { projectId?: string; url?: string; serviceKey?: string; anonKey?: string }
    | null;
  if (!body?.projectId || !body.url || !body.serviceKey) {
    return NextResponse.json({ ok: false, error: 'invalid_input' }, { status: 400 });
  }

  const project = await getProject(body.projectId, viewer);
  if (!project) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  if (!isValidSupabaseUrl(body.url)) {
    return NextResponse.json({ ok: false, error: 'url must be https://<ref>.supabase.co' }, { status: 400 });
  }
  const keyCheck = validateServiceKey(body.serviceKey);
  if (!keyCheck.valid) {
    return NextResponse.json({ ok: false, error: keyCheck.error }, { status: 400 });
  }

  // Live validation: service key se vault table (ya koi bhi) select — 401/403 = galat key
  const probe = await restSelect({ url: body.url, serviceKey: body.serviceKey }, CANARY_TABLE, { limit: 1 });
  if (probe.status === 401 || probe.status === 403) {
    return NextResponse.json({ ok: false, error: 'service key reject hui (401/403)' }, { status: 400 });
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
    return NextResponse.json({ ok: false, error: 'Failed to encrypt or save connection' }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') return NextResponse.json({ ok: false }, { status: 401 });
  const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!projectId) return NextResponse.json({ ok: false }, { status: 400 });
  const project = await getProject(projectId, viewer);
  if (!project) return NextResponse.json({ ok: false }, { status: 404 });
  await clearSupabaseConnection(projectId);
  return NextResponse.json({ ok: true });
}
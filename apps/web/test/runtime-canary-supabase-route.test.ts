import { beforeEach, describe, expect, it, vi } from 'vitest';

const getViewerMock = vi.fn();
const getProjectMock = vi.fn();
const saveSupabaseConnectionMock = vi.fn();
const getCanaryProjectConfigMock = vi.fn();
const listCanariesMock = vi.fn();
const markCanariesSetupMock = vi.fn();
const restSelectMock = vi.fn();

vi.mock('@/lib/authz', () => ({
  getViewer: (...args: unknown[]) => getViewerMock(...args),
}));

vi.mock('@scanlyfix/db', () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
  saveSupabaseConnection: (...args: unknown[]) => saveSupabaseConnectionMock(...args),
  clearSupabaseConnection: vi.fn(),
  getCanaryProjectConfig: (...args: unknown[]) => getCanaryProjectConfigMock(...args),
  listCanaries: (...args: unknown[]) => listCanariesMock(...args),
  markCanariesSetup: (...args: unknown[]) => markCanariesSetupMock(...args),
}));

vi.mock('@/lib/header-encryption', () => ({
  encryptValue: (v: string) => `enc_${v}`,
  decryptValue: (v: string) => v.replace(/^enc_/, ''),
}));

vi.mock('@/lib/runtime/canaries/supabase-rest', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runtime/canaries/supabase-rest')>(
    '@/lib/runtime/canaries/supabase-rest',
  );
  return {
    ...actual,
    restSelect: (...args: unknown[]) => restSelectMock(...args),
  };
});

import { POST } from '../app/api/runtime/supabase/route';
import { POST as verifyPOST } from '../app/api/runtime/supabase/verify/route';

describe('POST /api/runtime/supabase — service key validation (TASK 6)', () => {
  const makeJwt = (payload: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${header}.${p}.dummy_signature`;
  };

  const project = {
    id: 'proj-123',
    name: 'Test Project',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getViewerMock.mockResolvedValue({ kind: 'user', userId: 'user-1' });
    getProjectMock.mockResolvedValue(project);
    restSelectMock.mockResolvedValue({ status: 200, ok: true, data: [] });
  });

  it('rejects with helpful error when anon key JWT is pasted', async () => {
    const anonJwt = makeJwt({ role: 'anon', iss: 'supabase' });

    const req = new Request('https://scanlyfix.dev/api/runtime/supabase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-123',
        url: 'https://my-ref.supabase.co',
        serviceKey: anonJwt,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({
      ok: false,
      error: 'ye anon key hai — service key chahiye',
    });

    // Should not call live probe or save
    expect(restSelectMock).not.toHaveBeenCalled();
    expect(saveSupabaseConnectionMock).not.toHaveBeenCalled();
  });

  it('accepts sb_secret_ format and performs live REST validation', async () => {
    const req = new Request('https://scanlyfix.dev/api/runtime/supabase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-123',
        url: 'https://my-ref.supabase.co',
        serviceKey: 'sb_secret_prod_1234567890abcdef',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    // Live probe and save connection should be called
    expect(restSelectMock).toHaveBeenCalled();
    expect(saveSupabaseConnectionMock).toHaveBeenCalledWith(
      'proj-123',
      'https://my-ref.supabase.co',
      'enc_sb_secret_prod_1234567890abcdef',
      null,
    );
  });

  it('accepts service_role JWT and performs live REST validation', async () => {
    const srvJwt = makeJwt({ role: 'service_role', iss: 'supabase' });

    const req = new Request('https://scanlyfix.dev/api/runtime/supabase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'proj-123',
        url: 'https://my-ref.supabase.co',
        serviceKey: srvJwt,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    expect(restSelectMock).toHaveBeenCalled();
    expect(saveSupabaseConnectionMock).toHaveBeenCalledWith(
      'proj-123',
      'https://my-ref.supabase.co',
      `enc_${srvJwt}`,
      null,
    );
  });
});

describe('POST /api/runtime/supabase/verify — error handling & verification', () => {
  const project = { id: 'proj-123', name: 'Test Project' };
  const canaryConfig = {
    projectId: 'proj-123',
    supabaseUrl: 'https://my-ref.supabase.co',
    serviceKey: 'valid_service_key',
    anonKey: null,
    snapshot: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getViewerMock.mockResolvedValue({ kind: 'user', userId: 'user-1' });
    getProjectMock.mockResolvedValue(project);
    getCanaryProjectConfigMock.mockResolvedValue(canaryConfig);
    listCanariesMock.mockResolvedValue([
      { markerToken: 'CANARY::proj::A', status: 'pending_script' },
      { markerToken: 'CANARY::proj::B', status: 'pending_script' },
      { markerToken: 'CANARY::proj::C', status: 'pending_script' },
    ]);
  });

  it('returns 400 with helpful instruction when decoy table is missing (404)', async () => {
    restSelectMock.mockResolvedValueOnce({
      status: 404,
      ok: false,
      data: null,
      count: null,
      error: 'Not Found',
    });

    const req = new Request('https://scanlyfix.dev/api/runtime/supabase/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-123' }),
    });

    const res = await verifyPOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Decoy table 'scanlyfix_canaries' was not found in Supabase");
  });

  it('returns 400 when PostgREST returns schema cache error (PGRST200)', async () => {
    restSelectMock.mockResolvedValueOnce({
      status: 400,
      ok: false,
      data: null,
      count: null,
      error: '{"code":"PGRST200","message":"Could not find the table in the schema cache"}',
    });

    const req = new Request('https://scanlyfix.dev/api/runtime/supabase/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-123' }),
    });

    const res = await verifyPOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Decoy table 'scanlyfix_canaries' was not found in Supabase");
  });

  it('returns 400 when service key is rejected with 401 Unauthorized', async () => {
    restSelectMock.mockResolvedValueOnce({
      status: 401,
      ok: false,
      data: null,
      count: null,
      error: 'Unauthorized',
    });

    const req = new Request('https://scanlyfix.dev/api/runtime/supabase/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-123' }),
    });

    const res = await verifyPOST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain('Supabase rejected the service role key');
  });

  it('returns 502 with helpful advice when Supabase project is paused or waking up (502)', async () => {
    restSelectMock.mockResolvedValueOnce({
      status: 502,
      ok: false,
      data: null,
      count: null,
      error: 'Bad Gateway',
    });

    const req = new Request('https://scanlyfix.dev/api/runtime/supabase/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-123' }),
    });

    const res = await verifyPOST(req);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain('paused or is waking up');
  });

  it('succeeds and saves snapshot when table rows and markers match', async () => {
    restSelectMock
      // Rows query
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: [
          { marker: 'CANARY::proj::A', payload: { note: 'seed-a' } },
          { marker: 'CANARY::proj::B', payload: { note: 'seed-b' } },
          { marker: 'CANARY::proj::C', payload: { note: 'seed-c' } },
        ],
        count: 3,
      })
      // Log query
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: [],
        count: 0,
      });

    const req = new Request('https://scanlyfix.dev/api/runtime/supabase/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-123' }),
    });

    const res = await verifyPOST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.rows).toBe(3);
    expect(markCanariesSetupMock).toHaveBeenCalled();
  });
});

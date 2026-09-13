/*
Minimal typed PostgREST client — does NOT depend on supabase-js
(keeps the SDK zero-dependency).
Only these 4 operations are required: schema read (OpenAPI), select, rpc, and head-count.
*/

export type RestConfig = { url: string; serviceKey: string; anonKey?: string | null };

export type RestResult<T> = { status: number; ok: boolean; data: T | null; count: number | null; error?: string };

function headers(cfg: RestConfig, key: 'service' | 'anon', extra: Record<string, string> = {}): Record<string, string> {
  const k = key === 'anon' ? cfg.anonKey : cfg.serviceKey;
  return {
    apikey: k ?? '',
    authorization: `Bearer ${k ?? ''}`,
    'content-type': 'application/json',
    ...extra,
  };
}

export async function restSelect<T>(
  cfg: RestConfig,
  table: string,
  opts: {
    query?: string;
    key?: 'service' | 'anon';
    limit?: number;
    withCount?: boolean;
    retries?: number;
    retryDelayMs?: number;
  } = {},
): Promise<RestResult<T[]>> {
  const extra: Record<string, string> = {};
  if (opts.withCount) extra.prefer = 'count=exact';
  const q = [opts.query, opts.limit ? `limit=${opts.limit}` : null].filter(Boolean).join('&');
  const url = `${cfg.url.replace(/\/$/, '')}/rest/v1/${table}${q ? `?${q}` : ''}`;
  const maxAttempts = opts.retries ?? 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: headers(cfg, opts.key ?? 'service', extra),
        signal: AbortSignal.timeout(10_000),
      });
      const countHeader = res.headers.get('content-range');
      const count = countHeader ? Number(countHeader.split('/')[1]) : null;

      let data: T[] | null = null;
      let error: string | undefined;

      if (res.ok) {
        try {
          data = (await res.json()) as T[];
        } catch {
          data = null;
        }
        return { status: res.status, ok: res.ok, data, count: Number.isFinite(count) ? count : null };
      }

      error = await res.text().catch(() => '');

      // Check if this is a transient error that should be retried
      // (503 with PGRST002 schema cache reloading, or 502/504 gateway wakeup)
      const isTransient =
        res.status === 503 ||
        res.status === 502 ||
        res.status === 504 ||
        error.includes('PGRST002') ||
        error.toLowerCase().includes('schema cache');

      if (isTransient && attempt < maxAttempts) {
        const delayMs = opts.retryDelayMs ?? (attempt * 1200); // 1.2s, 2.4s
        console.log(`[restSelect] Supabase transient ${res.status} (${error.slice(0, 80)}). Retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})...`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      console.error(`[restSelect] HTTP ${res.status} on GET ${url}:`, error);
      return { status: res.status, ok: res.ok, data, count: Number.isFinite(count) ? count : null, error };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        const delayMs = attempt * 1000;
        console.log(`[restSelect] Fetch failure (${msg}). Retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})...`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      console.error(`[restSelect] Network/Fetch failure on GET ${url}:`, msg);
      return { status: 0, ok: false, data: null, count: null, error: msg };
    }
  }

  return { status: 0, ok: false, data: null, count: null, error: 'Request timed out after retries' };
}

/**
 * True zero-body count probe using HTTP HEAD.
 * Returns { status, count } from Content-Range header without reading response body bytes.
 */
export async function restHeadCount(
  cfg: RestConfig,
  table: string,
): Promise<{ status: number; count: number | null }> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/${table}`, {
      method: 'HEAD',
      headers: headers(cfg, 'anon', { prefer: 'count=exact' }),
      signal: AbortSignal.timeout(10_000),
    });
    const countHeader = res.headers.get('content-range');
    const count = countHeader ? Number(countHeader.split('/')[1]) : null;
    return { status: res.status, count: Number.isFinite(count) ? count : null };
  } catch {
    return { status: 0, count: null };
  }
}

export async function restRpc<T>(cfg: RestConfig, fn: string, body: unknown): Promise<RestResult<T>> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: headers(cfg, 'service'),
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(10_000),
    });
    const data = res.ok ? ((await res.json()) as T) : null;
    return { status: res.status, ok: res.ok, data, count: null };
  } catch {
    return { status: 0, ok: false, data: null, count: null };
  }
}

/** OpenAPI definitions → table names (schema read — "read your schema"). */
export async function listTableNames(cfg: RestConfig): Promise<string[] | null> {
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/`, {
      headers: headers(cfg, 'service'),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const spec = (await res.json()) as { definitions?: Record<string, unknown> };
    return spec.definitions ? Object.keys(spec.definitions) : null;
  } catch {
    return null;
  }
}

/** Validation — Prevent SSRF or malformed/invalid requests from reaching the REST client. */
export function isValidSupabaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /^[\w-]+\.supabase\.(co|in|red)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Deterministic service key validation:
 * 1. Supabase modern sb_secret_ prefix → valid
 * 2. JWT-shaped → base64url-decode payload:
 *    - role === 'service_role' → valid
 *    - role === 'anon' → reject with helpful error
 *    - anything else → reject as invalid
 */
export function validateServiceKey(key: string): { valid: true } | { valid: false; error: string } {
  if (typeof key !== 'string') {
    return { valid: false, error: 'invalid service key' };
  }

  if (key.startsWith('sb_secret_')) {
    return { valid: true };
  }

  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson) as { role?: unknown };
      if (payload && typeof payload === 'object') {
        if (payload.role === 'anon') {
          return { valid: false, error: 'ye anon key hai — service key chahiye' };
        }
        if (payload.role === 'service_role') {
          return { valid: true };
        }
      }
    } catch {
      return { valid: false, error: 'invalid service key' };
    }
  }

  return { valid: false, error: 'invalid service key' };
}
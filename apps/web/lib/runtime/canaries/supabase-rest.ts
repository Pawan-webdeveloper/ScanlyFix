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

/**
 * What is safe to put in a log line about someone else's database.
 *
 * The full URL carries the customer's project reference, and a PostgREST error
 * body can quote the offending row — a constraint violation message repeats the
 * values that violated it. Neither belongs in our logs, so only the table, the
 * status and the machine-readable code are kept.
 */
function safeErrorSummary(table: string, status: number, body: string): string {
  let code: string | null = null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    if (typeof parsed.code === 'string') code = parsed.code;
  } catch {
    code = null;
  }
  return `table=${table} status=${status}${code ? ` code=${code}` : ''}`;
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
        console.warn(`[restSelect] transient failure, retrying in ${delayMs}ms (${attempt}/${maxAttempts}): ${safeErrorSummary(table, res.status, error)}`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      console.error(`[restSelect] request failed: ${safeErrorSummary(table, res.status, error)}`);
      return { status: res.status, ok: res.ok, data, count: Number.isFinite(count) ? count : null, error };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        const delayMs = attempt * 1000;
        console.warn(`[restSelect] network failure, retrying in ${delayMs}ms (${attempt}/${maxAttempts}): table=${table}`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      console.error(`[restSelect] network failure after ${maxAttempts} attempts: table=${table} (${msg})`);
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

/**
 * Tests whether the anon key would be allowed to INSERT into a table, WITHOUT
 * writing anything.
 *
 * Reading is only half the question. A table an anonymous caller can write to is
 * worse than one they can read, and the read probe reports it as protected.
 *
 * The trick is to send a row the table's own constraints must reject. Postgres
 * evaluates the row-level security policy for an INSERT before it evaluates
 * column constraints, so the error code says which gate stopped it:
 *
 *   42501 / 401 / 403  the write was refused outright — the table is protected
 *   23502 (not null)   the policy let it through and only the NOT NULL
 *                      constraint stopped it, so a well-formed row WOULD be
 *                      written. That is the hole.
 *
 * Nothing is ever inserted on either path, which is what makes this safe to run
 * against a customer's production database.
 */
export async function restProbeAnonInsert(
  cfg: RestConfig,
  table: string,
): Promise<{ status: number; code: string | null; wouldWrite: boolean }> {
  if (!cfg.anonKey) return { status: 0, code: null, wouldWrite: false };
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/${table}`, {
      method: 'POST',
      headers: headers(cfg, 'anon', { prefer: 'return=minimal' }),
      // Deliberately empty: every column that matters is NOT NULL.
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return { status: res.status, code: null, wouldWrite: false };

    const body = await res.text().catch(() => '');
    let code: string | null = null;
    try {
      const parsed = JSON.parse(body) as { code?: unknown };
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      code = null;
    }

    // A constraint rejection means the policy did not object.
    const wouldWrite = code === '23502' || code === '23514' || code === '22P02';
    return { status: res.status, code, wouldWrite };
  } catch {
    return { status: 0, code: null, wouldWrite: false };
  }
}

/**
 * Writes a new payload to one decoy row, by marker.
 *
 * Used only by the self-test, and only against the row this system owns. It is
 * the one write the product makes into a customer's database, and it exists so
 * that "no alert" can mean "nothing happened" rather than "we have no idea".
 */
export async function restUpdatePayload(
  cfg: RestConfig,
  table: string,
  marker: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(
      `${cfg.url.replace(/\/$/, '')}/rest/v1/${table}?marker=eq.${encodeURIComponent(marker)}`,
      {
        method: 'PATCH',
        headers: headers(cfg, 'service', { prefer: 'return=minimal' }),
        body: JSON.stringify({ payload }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
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

/** Decodes a Supabase JWT's role claim, or null if it is not a JWT we can read. */
function jwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof payload?.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * The anon key must really be the anon key.
 *
 * It was stored with no validation at all, and the consequence is not a cosmetic
 * one: the RLS probe asks "can an anonymous caller read the decoy table?" using
 * whatever is in this field. A service role key bypasses row level security
 * entirely, so pasting one here makes the probe read every decoy row and report
 * a public-exposure breach on a perfectly secured database — the worst false
 * positive this product can emit, on its highest-severity finding.
 */
export function validateAnonKey(key: string): { valid: true } | { valid: false; error: string } {
  if (typeof key !== 'string' || key.trim().length === 0) {
    return { valid: false, error: 'The anon key is empty.' };
  }
  const trimmed = key.trim();

  if (trimmed.startsWith('sb_secret_')) {
    return {
      valid: false,
      error:
        'That is a secret key, not the anon key. The anon key is the public one your frontend ships with — using a secret key here would make every read test pass and report a breach that is not there.',
    };
  }

  const role = jwtRole(trimmed);
  if (role === 'service_role') {
    return {
      valid: false,
      error:
        'That is the service role key, not the anon key. It bypasses row level security, so the read test would see every row and report a public-exposure breach on a database that is actually secure.',
    };
  }
  if (role !== null && role !== 'anon' && role !== 'authenticated') {
    return { valid: false, error: `That key carries the "${role}" role. The anon (public) key is required here.` };
  }

  return { valid: true };
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
  if (typeof key !== 'string' || key.trim().length === 0) {
    return { valid: false, error: 'The service role key is empty.' };
  }

  if (key.startsWith('sb_secret_')) {
    return { valid: true };
  }

  const role = jwtRole(key);
  if (role === 'anon' || role === 'authenticated') {
    return {
      valid: false,
      error:
        'That is the public key. Canaries need the service role key — it is the only one that can read past row level security to check the decoy rows.',
    };
  }
  if (role === 'service_role') return { valid: true };

  return { valid: false, error: 'That does not look like a Supabase service role key. Copy it from Project Settings → API.' };
}
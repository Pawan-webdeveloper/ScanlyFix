/**
 * A real HTTP server that behaves like Supabase's PostgREST, for tests that
 * need the canary engine to actually talk to something.
 *
 * The existing canary tests mock `restSelect` wholesale, which means the parts
 * most likely to be wrong are never exercised: URL and query-string
 * construction, the apikey/authorization headers, service-key versus anon-key
 * behaviour, `Content-Range` count parsing, HEAD requests with no body, and the
 * retry path. All of those are HTTP details, and a mock of the function that
 * performs the HTTP cannot check any of them.
 *
 * This is deliberately a small, literal imitation of PostgREST rather than a
 * general fake: it implements only the four operations the canary feature uses,
 * and it answers the way PostgREST actually does — including returning an empty
 * array rather than a 403 when row-level security filters everything out, which
 * is the distinction the RLS probe is built on.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type FakeCanaryRow = { marker: string; payload: unknown };

export type FakeLogRow = {
  id: number;
  canary_marker: string;
  /** PostgREST returns the trigger's tg_op verbatim. */
  action: 'INSERT' | 'UPDATE' | 'DELETE';
  old_payload: unknown;
  acted_at: string;
};

export type FakeSupabaseState = {
  serviceKey: string;
  anonKey: string;
  /** Rows in the decoy table. Remove one to simulate a deletion. */
  canaryRows: FakeCanaryRow[];
  /** Rows the trigger has written. Append one to simulate a touch. */
  logRows: FakeLogRow[];
  /** Whether the decoy table exists at all. false → 404, as PostgREST reports a missing relation. */
  canaryTableExists: boolean;
  /**
   * Whether the trigger log table exists. Dropping only this one is the case
   * that matters most: the decoys still look perfect, so every other signal
   * reads "all clear" while nothing is being recorded any more.
   */
  logTableExists: boolean;
  /** Tables the OpenAPI spec advertises. */
  tables: string[];
  /** Row counts the ANON key can see per table. A table absent here is fully protected. */
  anonReadable: Record<string, number>;
  /** When true the AFTER UPDATE trigger does not fire, as if it had been dropped. */
  triggerDisabled: boolean;
  /** When true the anon role is allowed to INSERT into the decoy table. */
  anonCanInsert: boolean;
  /**
   * Status to answer with instead of serving the request, and how many times.
   * Models a paused project (503), a cold start (502) or a bad key (401).
   */
  failWith: { status: number; body?: string; times: number } | null;
};

export type FakeSupabase = {
  url: string;
  state: FakeSupabaseState;
  /** Every request the server saw, in order. */
  requests: Array<{ method: string; path: string; key: 'service' | 'anon' | 'unknown'; prefer: string | null }>;
  close: () => Promise<void>;
};

export function defaultState(overrides: Partial<FakeSupabaseState> = {}): FakeSupabaseState {
  return {
    serviceKey: 'sb_secret_service_key',
    anonKey: 'sb_publishable_anon_key',
    canaryRows: [
      { marker: 'CANARY::proj1234::A', payload: { note: 'legacy integration backup', api_key: 'sk-live-cnf-aaa' } },
      { marker: 'CANARY::proj1234::B', payload: { note: 'legacy integration backup', api_key: 'sk-live-cnf-bbb' } },
      { marker: 'CANARY::proj1234::C', payload: { note: 'legacy integration backup', api_key: 'sk-live-cnf-ccc' } },
    ],
    logRows: [],
    canaryTableExists: true,
    logTableExists: true,
    tables: ['scanlyfix_canaries', 'scanlyfix_canary_log', 'users', 'orders', 'public_posts'],
    anonReadable: { public_posts: 12 },
    triggerDisabled: false,
    anonCanInsert: false,
    failWith: null,
    ...overrides,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => resolve(body));
  });
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** PostgREST reports counts in a `Content-Range: <from>-<to>/<total>` header. */
function contentRange(total: number): string {
  return total === 0 ? `*/0` : `0-${total - 1}/${total}`;
}

function parseQuery(rawPath: string): { table: string; params: URLSearchParams } {
  const url = new URL(rawPath, 'http://fake.local');
  const table = url.pathname.replace(/^\/rest\/v1\/?/, '');
  return { table, params: url.searchParams };
}

/** PostgREST's `id=gt.7` / `order=id.asc` / `limit=20` subset the canary engine uses. */
function applyFilters(rows: FakeLogRow[], params: URLSearchParams): FakeLogRow[] {
  let out = [...rows];
  const idFilter = params.get('id');
  if (idFilter) {
    const match = /^(gt|gte|lt|lte|eq)\.(\d+)$/.exec(idFilter);
    if (match) {
      const op = match[1];
      const value = Number(match[2]);
      out = out.filter((r) =>
        op === 'gt' ? r.id > value : op === 'gte' ? r.id >= value : op === 'lt' ? r.id < value : op === 'lte' ? r.id <= value : r.id === value,
      );
    }
  }
  const order = params.get('order');
  if (order?.startsWith('id.')) {
    out.sort((a, b) => (order.endsWith('.desc') ? b.id - a.id : a.id - b.id));
  }
  const limit = params.get('limit');
  if (limit && Number.isFinite(Number(limit))) out = out.slice(0, Number(limit));
  return out;
}

export async function startFakeSupabase(initial: Partial<FakeSupabaseState> = {}): Promise<FakeSupabase> {
  const state = defaultState(initial);
  const requests: FakeSupabase['requests'] = [];

  function keyKind(req: IncomingMessage): 'service' | 'anon' | 'unknown' {
    const apikey = req.headers['apikey'];
    const value = Array.isArray(apikey) ? apikey[0] : apikey;
    if (value === state.serviceKey) return 'service';
    if (value === state.anonKey) return 'anon';
    return 'unknown';
  }

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, bodyless = false): void {
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(bodyless ? undefined : payload);
  }

  const server: Server = createServer((req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawPath = req.url ?? '/';
    const key = keyKind(req);
    const preferHeader = req.headers['prefer'];
    const prefer = (Array.isArray(preferHeader) ? preferHeader[0] : preferHeader) ?? null;
    requests.push({ method, path: rawPath, key, prefer });

    // ── Forced failure, for paused projects and cold starts ─────────────────
    if (state.failWith && state.failWith.times > 0) {
      state.failWith.times -= 1;
      const { status, body } = state.failWith;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body ?? JSON.stringify({ message: `forced ${status}` }));
      return;
    }

    // ── An unrecognised key is rejected the way PostgREST rejects one ───────
    if (key === 'unknown') {
      send(res, 401, { message: 'Invalid API key' });
      return;
    }

    // ── OpenAPI schema read, used to enumerate tables ───────────────────────
    if (rawPath === '/rest/v1/' || rawPath === '/rest/v1') {
      if (key !== 'service') {
        send(res, 401, { message: 'Invalid API key' });
        return;
      }
      const definitions: Record<string, unknown> = {};
      for (const t of state.tables) definitions[t] = { type: 'object' };
      send(res, 200, { definitions });
      return;
    }

    const { table, params } = parseQuery(rawPath);
    const wantsCount = (prefer ?? '').includes('count=exact');
    const bodyless = method === 'HEAD';

    // ── The decoy table ────────────────────────────────────────────────────
    if (table === 'scanlyfix_canaries') {
      if (!state.canaryTableExists) {
        send(res, 404, { message: `relation "public.${table}" does not exist`, code: '42P01' }, {}, bodyless);
        return;
      }

      // A write, which in a real database fires the AFTER UPDATE trigger. The
      // fake fires it too, because the self-test's whole purpose is to check
      // that the trigger responded — a fake that skipped it would report the
      // detector as broken on a healthy database.
      if (method === 'PATCH' || method === 'PUT') {
        if (key !== 'service') {
          send(res, 401, { message: 'Invalid API key' });
          return;
        }
        const target = params.get('marker')?.replace(/^eq\./, '');
        const row = state.canaryRows.find((r) => r.marker === decodeURIComponent(target ?? ''));
        if (row) {
          readBody(req).then((body) => {
            const parsed = safeJson(body);
            if (parsed && typeof parsed === 'object' && 'payload' in parsed) {
              row.payload = (parsed as { payload: unknown }).payload;
            }
            if (!state.triggerDisabled && state.logTableExists) {
              recordTrigger(state, { marker: row.marker, action: 'UPDATE', oldPayload: {}, actedAt: new Date().toISOString() });
            }
            send(res, 204, null, {}, true);
          });
          return;
        }
        send(res, 204, null, {}, true);
        return;
      }

      // An INSERT probe. RLS with no policy refuses the anon role outright.
      if (method === 'POST') {
        if (key === 'anon' && !state.anonCanInsert) {
          send(res, 403, { message: 'new row violates row-level security policy', code: '42501' });
          return;
        }
        // The policy allowed it; only the NOT NULL constraint stops the row.
        send(res, 400, { message: 'null value in column "marker" violates not-null constraint', code: '23502' });
        return;
      }
      // RLS is enabled with no policy for anon: PostgREST answers 200 with an
      // empty set, NOT 403. The whole RLS probe depends on that distinction.
      const visible = key === 'service' ? state.canaryRows : anonRows(state, 'scanlyfix_canaries');
      const limited = params.get('limit') ? visible.slice(0, Number(params.get('limit'))) : visible;
      send(res, 200, limited, wantsCount ? { 'content-range': contentRange(visible.length) } : {}, bodyless);
      return;
    }

    // ── The trigger log ────────────────────────────────────────────────────
    if (table === 'scanlyfix_canary_log') {
      if (!state.canaryTableExists || !state.logTableExists) {
        send(res, 404, { message: `relation "public.${table}" does not exist`, code: '42P01' }, {}, bodyless);
        return;
      }
      const visible = key === 'service' ? state.logRows : [];
      const filtered = applyFilters(visible, params);
      send(res, 200, filtered, wantsCount ? { 'content-range': contentRange(visible.length) } : {}, bodyless);
      return;
    }

    // ── Any other application table, for the anon-access audit ─────────────
    if (!state.tables.includes(table)) {
      send(res, 404, { message: `relation "public.${table}" does not exist`, code: '42P01' }, {}, bodyless);
      return;
    }
    const count = key === 'anon' ? (state.anonReadable[table] ?? 0) : 999;
    send(res, 200, [], wantsCount ? { 'content-range': contentRange(count) } : {}, bodyless);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake supabase failed to bind');

  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Rows the anon key can see in the decoy table — normally none, unless RLS is broken. */
function anonRows(state: FakeSupabaseState, table: string): FakeCanaryRow[] {
  const exposed = state.anonReadable[table] ?? 0;
  return state.canaryRows.slice(0, exposed);
}

/** Convenience: append a trigger-log row the way the SQL trigger would. */
export function recordTrigger(
  state: FakeSupabaseState,
  input: { marker: string; action: 'INSERT' | 'UPDATE' | 'DELETE'; oldPayload: unknown; actedAt: string },
): void {
  const nextId = state.logRows.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  state.logRows.push({
    id: nextId,
    canary_marker: input.marker,
    action: input.action,
    old_payload: input.oldPayload,
    acted_at: input.actedAt,
  });
}

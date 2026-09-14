import { buildEvidence } from './analyze';
import { PROBE_MAX_BODY_BYTES, PROBE_TIMEOUT_MS, PROBE_USER_AGENT, type ProbeEvidence, type ProbeOutcome } from './types';

export const SAFE_VALUES: Readonly<Record<string, string>> = {
  id: '1',
  postId: '1',
  email: 'test%40example.com',
  token: 'test',
  slug: 'test',
};

/** Second value set used by the sequential-ID (IDOR) check: same route, neighbouring id. */
export const ALT_ID_VALUE = '2';

/** Route placeholders that stand for a numeric record id. */
const ID_PARAM = /\[(id|[a-zA-Z]+Id)\]/;

export function hasIdPlaceholder(path: string): boolean {
  return ID_PARAM.test(path);
}

/**
 * Dynamic route parameter sanitizer.
 * Replaces route placeholders (e.g. [id], [postId], [email], [slug]) with safe test values.
 *
 * NOTE: Dynamic routes whose substituted ID does not exist on the target server
 * will return 404 Not Found. Under Auth Prober classification, 404 is evaluated as
 * 'inconclusive' and produces no finding. This is by design: probing unknown dynamic IDs
 * should never create false-positive auth alarms.
 */
export function sanitizeProbePath(rawPath: string, options?: { idValue?: string }): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  return rawPath.replace(/\[([^\]]+)\]/g, (_match, paramName: string) => {
    if (options?.idValue && ID_PARAM.test(`[${paramName}]`)) return options.idValue;
    return SAFE_VALUES[paramName] ?? 'test';
  });
}

/**
 * Validates whether a target path meets safety, SSRF, and formatting constraints.
 * Path must start with '/', not contain '..', not exceed 200 characters,
 * not exceed 200 characters after dynamic parameter substitution, and not contain whitespace.
 */
export function isValidProbePath(path: string): boolean {
  if (!path || typeof path !== 'string') return false;
  if (!path.startsWith('/') || path.includes('..') || path.length > 200) return false;
  if (/\s/.test(path)) return false;
  const concretePath = sanitizeProbePath(path);
  if (!concretePath || !concretePath.startsWith('/') || concretePath.length > 200) return false;
  return true;
}

/**
 * SSRF guard: hostname sirf verified DB value se aata hai, phir bhi
 * explicit allow-check — kyunki ye function real internet pe fire karta hai.
 */
export function buildProbeUrl(hostname: string, path: string, options?: { idValue?: string }): string | null {
  if (!isValidProbePath(path)) return null;
  const concretePath = sanitizeProbePath(path, options);
  if (concretePath.length > 200) return null;

  if (process.env.NODE_ENV !== 'production') {
    const isLocal =
      hostname === 'localhost' ||
      hostname.startsWith('localhost:') ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('127.0.0.1:');
    if (isLocal) {
      return `http://${hostname}${concretePath}`;
    }
  }

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname)) return null; // no localhost, no IPs, no ports
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return null;
  return `https://${hostname}${concretePath}`;
}

type FetchLike = {
  status: number;
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** Read at most PROBE_MAX_BODY_BYTES of the body as text. Body read failure ≠ probe failure. */
async function readBody(res: FetchLike): Promise<{ text: string; bytes: number }> {
  try {
    const buf = await res.arrayBuffer();
    const bytes = buf.byteLength;
    const slice = bytes > PROBE_MAX_BODY_BYTES ? buf.slice(0, PROBE_MAX_BODY_BYTES) : buf;
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(slice), bytes };
  } catch {
    return { text: '', bytes: 0 };
  }
}

function header(res: FetchLike, name: string): string | null {
  try {
    return res.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

async function executeProbe(
  url: string,
  headers: Record<string, string>,
  homeBodyHash?: string | null,
): Promise<ProbeOutcome> {
  try {
    const res = (await fetch(url, {
      method: 'GET',
      redirect: 'manual', // ⭐ iske bina 307→/login follow hota aur HAR protected route false-alarm karta.
      cache: 'no-store',
      headers: { 'user-agent': PROBE_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })) as unknown as FetchLike;

    const { text, bytes } = await readBody(res);
    const evidence: ProbeEvidence = buildEvidence({
      status: res.status,
      contentType: header(res, 'content-type'),
      body: text,
      bodyBytes: bytes,
      location: header(res, 'location'),
      wwwAuthenticate: header(res, 'www-authenticate'),
      homeBodyHash,
    });
    return { ok: true, status: res.status, evidence };
  } catch (e) {
    // Timeout / DNS fail / app down → ye AUTH issue nahi hai. Error report karo, alarm nahi.
    return { ok: false, error: e instanceof Error ? e.message : 'network_error' };
  }
}

export type ProbeOptions = {
  /** Homepage body hash — lets the analyser recognise an SPA shell answering for every route. */
  homeBodyHash?: string | null;
  /** Override the numeric id substituted for [id]-style placeholders. */
  idValue?: string;
};

/**
 * Ek target ko logged-out visitor ki tarah probe karo.
 * Jaan-boojh ke koi cookie/auth header nahi — hum wahi logged-out stranger hain.
 */
export async function probeTarget(hostname: string, path: string, options?: ProbeOptions): Promise<ProbeOutcome> {
  const url = buildProbeUrl(hostname, path, { idValue: options?.idValue });
  if (!url) return { ok: false, error: 'invalid_target' };
  return executeProbe(url, {}, options?.homeBodyHash);
}

/**
 * Ek target ko public Supabase anon key ke sath probe karo.
 * Supabase RLS / anon-role leaks ko detect karta hai.
 */
export async function probeTargetWithAnonKey(
  hostname: string,
  path: string,
  anonKey: string,
  options?: ProbeOptions,
): Promise<ProbeOutcome> {
  const url = buildProbeUrl(hostname, path, { idValue: options?.idValue });
  if (!url) return { ok: false, error: 'invalid_target' };
  return executeProbe(url, { apikey: anonKey, authorization: `Bearer ${anonKey}` }, options?.homeBodyHash);
}

/**
 * Fingerprint of the homepage body. Single-page apps answer 200 with this same
 * shell for every unknown route; knowing the hash lets every later probe tell
 * "the admin page is open" from "the router will redirect once JS runs".
 * Returns null when the homepage cannot be read — analysis then simply skips the shell check.
 */
export async function fetchHomeFingerprint(hostname: string): Promise<string | null> {
  const outcome = await probeTarget(hostname, '/');
  if (!outcome.ok || !outcome.evidence) return null;
  if (outcome.status < 200 || outcome.status >= 300) return null;
  if (outcome.evidence.bodyKind !== 'html_app' && outcome.evidence.bodyKind !== 'login_page') return null;
  return outcome.evidence.bodyHash;
}

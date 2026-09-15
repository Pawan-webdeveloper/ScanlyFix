export type TargetSource = 'default' | 'guard' | 'manual';
export type FindingSeverity = 'critical' | 'high';

/**
 * What kind of surface a path is. Derived from the path itself (pure), so it
 * never needs a DB column and old targets get categorised for free.
 *
 *   admin     — /admin, /internal, /console …  (control panels)
 *   api       — /api/*, /graphql, /rest/*        (data endpoints)
 *   debug     — /debug, /actuator, /phpinfo …    (dev tooling left in prod)
 *   auth_page — /dashboard, /account, /settings  (ordinary logged-in pages)
 */
export type TargetCategory = 'admin' | 'api' | 'debug' | 'auth_page';

export type ProbeVariant = 'logged_out' | 'anon_role';

/**
 * How a finding was produced.
 *   null           — protected at baseline, now 2xx without login (regression)
 *   'anon_role'    — protected without a key, but 2xx with the public Supabase anon key
 *   'exposed'      — already 2xx on the very first probe (never protected)
 *   'sequential_id'— /…/[id] answers 2xx JSON for id=1 AND id=2 with different bodies (IDOR)
 */
export type FindingVariant = 'anon_role' | 'exposed' | 'sequential_id' | null;

/** What the response body looked like. The status code alone lies far too often. */
export type BodyKind =
  | 'login_page' // 200, but it is the sign-in form → still protected
  | 'soft_404' // 200, but "page not found" → nothing here
  | 'spa_shell' // 200, identical to the homepage shell → client-side routing, inconclusive
  | 'json_data' // 2xx JSON that carries data (array / non-error object)
  | 'json_error' // 2xx JSON shaped like { error | message | statusCode }
  | 'html_app' // real HTML content (not login, not 404, not shell)
  | 'text' // plain text / other non-HTML body
  | 'empty' // no body at all
  | 'redirect'; // 3xx — body irrelevant
export type ProbeEvidence = {
  contentType: string | null;
  bodyBytes: number;
  /** First ~240 chars of the body with tags/whitespace collapsed — never secrets, never the whole file. */
  bodySample: string;
  /** SHA-256 (16 hex) of the normalised body — for SPA-shell comparison with the homepage. */
  bodyHash: string;
  /** `Location` header on 3xx, when present. */
  location: string | null;
  /** `WWW-Authenticate` header, when present. */
  wwwAuthenticate: string | null;
  bodyKind: BodyKind;
  /** Extracted <title>, when HTML. */
  title: string | null;
};

export type ProbeOutcome =
  | { ok: true; status: number; evidence?: ProbeEvidence }
  | { ok: false; error: string };

/** Har target ka runtime verdict — discriminated union, exhaustive switch possible. */
export type TargetVerdict =
  | { verdict: 'baseline_recorded'; status: number }
  /** First probe ever AND the surface is already open — no baseline to compare, but it is a finding today. */
  | { verdict: 'exposed'; status: number; severity: FindingSeverity; reason: string }
  | { verdict: 'protected'; status: number; reason?: string }
  | { verdict: 'open'; status: number; severity: FindingSeverity; reason: string }
  | { verdict: 'anon_open'; status: number; anonStatus: number; severity: FindingSeverity }
  | { verdict: 'inconclusive'; status: number; reason: string }
  | { verdict: 'error'; error: string };

export type ProberFindingItem = {
  path: string;
  severity: FindingSeverity;
  baselineStatus: number;
  actualStatus: number;
  variant?: FindingVariant;
  keyFingerprint?: string | null;
  category?: TargetCategory;
  reason?: string | null;
  evidence?: ProbeEvidence | null;
  /** True when the path is flapping — the alert is recorded but not emailed again. */
  alertSuppressed?: boolean;
};

export type ProberRunSummary = {
  projectId: string;
  ranAt: string;
  baselinesRecorded: number;
  checked: number;
  newFindings: number;
  autoResolved: number;
  stillOpen: number;
  errors: number;
  /** Targets that answered but could not be judged (soft-404, SPA shell, 404/5xx…). */
  inconclusive?: number;
  /** New findings whose email was withheld because the path is flapping. */
  suppressedAlerts?: number;
};

export const PROBE_USER_AGENT = 'ScanlyFixAuthProber/1.0 (+https://scanlyfix.com/bot)';
export const PROBE_TIMEOUT_MS = 10_000;
/** Bytes of body we are willing to read for classification. Enough for any HTML head or JSON page. */
export const PROBE_MAX_BODY_BYTES = 64 * 1024;
export const PROBE_BODY_SAMPLE_CHARS = 240;
export const MAX_TARGETS_PER_PROJECT = 80;
export const PROBE_PARALLELISM = 5;

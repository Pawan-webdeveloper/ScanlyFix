/**
 * What an attack attempt looks like once it has been recognised.
 *
 * The detector runs inside the CUSTOMER'S middleware, on the hot path of every
 * request their users make. Three properties follow from that and are not
 * negotiable anywhere in this directory:
 *
 *   1. It never throws. A crash here is an outage on someone else's site.
 *   2. It is linear in the length of the input, with a hard cap on that length.
 *      No regex with nested quantifiers, no unbounded scanning — a detector that
 *      can be made to spin is a denial-of-service vector we shipped ourselves.
 *   3. It never carries user data home. The path is normalised to its route
 *      shape and the evidence is the matched attack substring, truncated —
 *      never a body, never a cookie, never a full URL.
 */

/** What the attacker was trying to do. Closed set; the server validates against it. */
export type ThreatKind =
  | 'sql_injection'
  | 'nosql_injection'
  | 'xss'
  | 'path_traversal'
  | 'command_injection'
  | 'code_injection'
  | 'template_injection'
  | 'ssrf'
  | 'secret_probe'
  | 'scanner'
  /**
   * A sign-in was attempted. Middleware cannot see whether it succeeded, so this
   * claims only what was observed; on its own it is not a finding and is never
   * shown in the feed.
   */
  | 'auth_attempt'
  /** A sign-in the application itself told us had failed. Precise, and opt-in. */
  | 'auth_failure'
  /** Raised by the server once attempts from one source cross a threshold. */
  | 'brute_force';

export type ThreatSeverity = 'critical' | 'high' | 'medium';

/**
 * How sure we are.
 *
 * Only `certain` and `likely` are ever reported. A rule that cannot reach at
 * least `likely` without guessing does not belong in the catalogue: this
 * product's whole claim is that what it shows you actually happened.
 */
export type ThreatConfidence = 'certain' | 'likely';

/** Which part of the request the payload was found in. */
export type ThreatSurface = 'path' | 'query' | 'header' | 'user_agent';

export const THREAT_KINDS: ReadonlyArray<ThreatKind> = [
  'sql_injection',
  'nosql_injection',
  'xss',
  'path_traversal',
  'command_injection',
  'code_injection',
  'template_injection',
  'ssrf',
  'secret_probe',
  'scanner',
  'auth_attempt',
  'auth_failure',
  'brute_force',
];

export const THREAT_SURFACES: ReadonlyArray<ThreatSurface> = ['path', 'query', 'header', 'user_agent'];

/** Severity is a property of the attack class, not of the individual request. */
export const SEVERITY_BY_KIND: Readonly<Record<ThreatKind, ThreatSeverity>> = {
  sql_injection: 'critical',
  nosql_injection: 'critical',
  command_injection: 'critical',
  code_injection: 'critical',
  path_traversal: 'critical',
  brute_force: 'high',
  xss: 'high',
  ssrf: 'high',
  secret_probe: 'high',
  template_injection: 'high',
  scanner: 'medium',
  auth_failure: 'medium',
  auth_attempt: 'medium',
};

/** What the detector found, before it is turned into an event. */
export type ThreatMatch = {
  kind: ThreatKind;
  confidence: ThreatConfidence;
  surface: ThreatSurface;
  /** Rule that fired, for our own debugging. Never shown to the customer. */
  ruleId: string;
  /** The offending substring, truncated. Used verbatim as the UI's evidence. */
  evidence: string;
};

/** The wire event. Mirrors what the ingest route validates and stores. */
export type ThreatEvent = {
  type: 'threat';
  kind: ThreatKind;
  confidence: ThreatConfidence;
  surface: ThreatSurface;
  ruleId: string;
  evidence: string;
  /** Route SHAPE, never the concrete path — `/api/users/[id]`, not `/api/users/42`. */
  pattern: string;
  method: string;
  /** Attacker's address, when the platform exposed it. Null rather than a guess. */
  sourceIp?: string | null;
  /** Truncated user agent, which is how tooling gives itself away. */
  userAgent?: string | null;
  /** Whether the customer's own middleware turned this request away. */
  blocked?: boolean;
  /** Status the wrapped middleware returned, when it returned one. */
  status?: number | null;
  /**
   * How many occurrences this row stands for.
   *
   * Always 1 from this SDK, which reports every occurrence separately so the
   * totals are exact. It stays in the wire contract for a caller that genuinely
   * can fold — a long-lived backend reporting "47 failed sign-ins since my last
   * flush" — and the ingest route bounds whatever is claimed.
   */
  count?: number;
};

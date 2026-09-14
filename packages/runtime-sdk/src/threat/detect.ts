/**
 * Turning a request into a verdict.
 *
 * Attackers encode. `%27` is a quote, `%252e%252e` is `..` behind two layers,
 * `&lt;script&gt;` is a script tag that survived an HTML-escaping middleware.
 * Matching raw bytes against a pattern list catches only the laziest scanners,
 * so the text is decoded first — but decoding is also where a detector gets
 * slow, so every step here is bounded and every input is capped before it is
 * touched.
 */

import {
  ALWAYS_RULES,
  TRIGGERED_RULES,
  hasTriggerChar,
  type Rule,
} from './signatures.ts';
import { SEVERITY_BY_KIND, type ThreatMatch, type ThreatSurface } from './types.ts';

/** Per-surface input caps. Anything past these is not evidence, it is ballast. */
const MAX_PATH = 1024;
const MAX_QUERY = 4096;
const MAX_HEADER = 512;

/** How much of the offending text is kept as evidence. */
const EVIDENCE_WINDOW = 120;

/** Distinct attack classes reported for one request. */
const MAX_MATCHES = 3;

/**
 * Headers worth reading.
 *
 * An allowlist, not a blocklist. Cookies and authorization headers carry the
 * user's own secrets, and a security product that hoovers those up to look for
 * attacks has become the attack. Log4Shell-style payloads ride in exactly these
 * fields, which is why they are here and nothing else is.
 */
export const SCANNED_HEADERS: ReadonlyArray<string> = [
  'referer',
  'x-forwarded-for',
  'x-api-version',
  'x-original-url',
  'x-rewrite-url',
  'x-forwarded-host',
];

const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;?/gi, '<'],
  [/&gt;?/gi, '>'],
  [/&quot;?/gi, '"'],
  [/&apos;?/gi, "'"],
  [/&#0*39;?/g, "'"],
  [/&#x0*27;?/gi, "'"],
  [/&#0*60;?/g, '<'],
  [/&#x0*3c;?/gi, '<'],
];

/** Percent-decodes once, tolerating the malformed sequences attackers send on purpose. */
function decodeOnce(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // `%zz` and lone `%` make decodeURIComponent throw and take the whole string
    // with it. Decoding the well-formed escapes individually keeps the payload
    // readable, which is the only reason we are decoding at all.
    return value.replace(/%[0-9a-fA-F]{2}/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
}

/**
 * Request text as the application will finally interpret it.
 *
 * Two decode passes, because double-encoding is the standard way past a filter
 * that only does one. A third pass buys nothing real and costs another walk of
 * the string.
 */
export function normalizeForScan(raw: string, cap: number): string {
  if (!raw) return '';
  let text = raw.length > cap ? raw.slice(0, cap) : raw;

  // `+` is a space in a query string, and `or+1=1` is the form that actually
  // arrives.
  if (text.includes('+')) text = text.replace(/\+/g, ' ');

  text = decodeOnce(text);
  text = decodeOnce(text);

  if (text.includes('&')) {
    for (const [pattern, replacement] of ENTITIES) text = text.replace(pattern, replacement);
  }

  text = text.toLowerCase();

  // Collapse runs of whitespace so `union%0a%09select` reads as `union select`.
  // Control characters become spaces rather than vanishing, so tokens on either
  // side of one cannot be glued into a word that was never there.
  text = text.replace(/[\s\u0001-\u0008\u000b-\u001f\u007f]+/g, ' ');

  return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * The same text with inline-comment obfuscation removed.
 *
 * Splitting a keyword with an empty SQL comment — `un`, comment, `ion` — is a
 * real evasion against literal matching, and costs the attacker nothing.
 * Returns null when there was nothing to strip, so the caller skips a second
 * scan on the overwhelming majority of requests.
 */
export function deobfuscate(text: string): string | null {
  if (!text.includes('/*')) return null;
  const stripped = text.replace(/\/\*.{0,64}?\*\//g, '').replace(/\s+/g, ' ');
  return stripped === text ? null : stripped;
}

function ruleMatches(rule: Rule, text: string): boolean {
  if (rule.all) {
    for (const literal of rule.all) {
      if (!text.includes(literal)) return false;
    }
  }
  if (rule.any) {
    let hit = false;
    for (const literal of rule.any) {
      if (text.includes(literal)) {
        hit = true;
        break;
      }
    }
    if (!hit) return false;
  }
  if (rule.re && !rule.re.test(text)) return false;
  return Boolean(rule.all || rule.any || rule.re);
}

/** Where in the text the rule fired, so the evidence shows the payload and not the prefix. */
function matchOffset(rule: Rule, text: string): number {
  if (rule.re) {
    const m = rule.re.exec(text);
    if (m) return m.index;
  }
  let best = -1;
  for (const literal of [...(rule.any ?? []), ...(rule.all ?? [])]) {
    const at = text.indexOf(literal);
    if (at >= 0 && (best === -1 || at < best)) best = at;
  }
  return best === -1 ? 0 : best;
}

/**
 * A readable slice of the payload, with anything that looks like a credential
 * taken out.
 *
 * The evidence is shown to the customer and stored in our database, so it gets
 * the same treatment as everything else that leaves their process: enough to
 * recognise the attack, nothing that could be a session token that happened to
 * be sitting in a Referer.
 */
export function buildEvidence(text: string, offset: number): string {
  const start = Math.max(0, offset - 24);
  let slice = text.slice(start, start + EVIDENCE_WINDOW);
  if (start > 0) slice = `…${slice}`;
  if (start + EVIDENCE_WINDOW < text.length) slice = `${slice}…`;
  return slice
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[A-Za-z0-9_-]{28,}/g, '[redacted]')
    .trim()
    .slice(0, EVIDENCE_WINDOW + 2);
}

/** Runs the catalogue over one piece of text. Returns every distinct kind that fired. */
export function scanText(text: string, surface: ThreatSurface): ThreatMatch[] {
  if (!text) return [];
  const matches: ThreatMatch[] = [];
  const seen = new Set<string>();
  const useTriggered = hasTriggerChar(text);

  const consider = (rule: Rule): void => {
    if (rule.surfaces && !rule.surfaces.includes(surface)) return;
    if (seen.has(rule.kind)) return;
    if (!ruleMatches(rule, text)) return;
    seen.add(rule.kind);
    matches.push({
      kind: rule.kind,
      confidence: rule.confidence,
      surface,
      ruleId: rule.id,
      evidence: buildEvidence(text, matchOffset(rule, text)),
    });
  };

  for (const rule of ALWAYS_RULES) consider(rule);
  if (useTriggered) {
    for (const rule of TRIGGERED_RULES) consider(rule);
  }
  return matches;
}

const SEVERITY_ORDER: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2 };

/** Worst and most certain first, so a truncated list keeps what matters. */
function rank(a: ThreatMatch, b: ThreatMatch): number {
  const bySeverity = SEVERITY_ORDER[SEVERITY_BY_KIND[a.kind]]! - SEVERITY_ORDER[SEVERITY_BY_KIND[b.kind]]!;
  if (bySeverity !== 0) return bySeverity;
  if (a.confidence !== b.confidence) return a.confidence === 'certain' ? -1 : 1;
  return 0;
}

export type RequestSnapshotForThreats = {
  /** Concrete pathname, before normalisation. The payload often lives here. */
  pathname: string;
  /** Raw query string, with or without the leading '?'. */
  search?: string | null;
  userAgent?: string | null;
  /** Only the headers in SCANNED_HEADERS are read. */
  header?: (name: string) => string | null | undefined;
};

/**
 * Everything worth reporting about one request.
 *
 * Never throws: a detector that can crash the middleware it lives in has a
 * worse failure mode than the attacks it is looking for.
 */
export function detectThreats(input: RequestSnapshotForThreats): ThreatMatch[] {
  try {
    const found: ThreatMatch[] = [];

    const scan = (raw: string | null | undefined, cap: number, surface: ThreatSurface): void => {
      if (!raw) return;
      const text = normalizeForScan(raw, cap);
      if (!text) return;
      found.push(...scanText(text, surface));
      const cleaned = deobfuscate(text);
      if (cleaned) found.push(...scanText(cleaned, surface));
    };

    scan(input.pathname, MAX_PATH, 'path');
    scan(input.search, MAX_QUERY, 'query');
    scan(input.userAgent, MAX_HEADER, 'user_agent');

    // The user agent is scanned twice on purpose. The first pass uses the
    // 'user_agent' surface, where the tooling fingerprints live; this one uses
    // 'header', which is where the payload rules apply — Log4Shell and its
    // relatives are sent in the User-Agent more often than anywhere else.
    if (input.userAgent) {
      const ua = normalizeForScan(input.userAgent, MAX_HEADER);
      found.push(...scanText(ua, 'header'));
    }

    if (input.header) {
      for (const name of SCANNED_HEADERS) {
        let value: string | null | undefined;
        try {
          value = input.header(name);
        } catch {
          value = null;
        }
        scan(value, MAX_HEADER, 'header');
      }
    }

    if (found.length === 0) return [];

    // One payload commonly trips several rules. The customer needs to know what
    // was attempted, not to read the same request five times.
    const byKind = new Map<string, ThreatMatch>();
    for (const match of found) {
      const existing = byKind.get(match.kind);
      if (!existing || (existing.confidence === 'likely' && match.confidence === 'certain')) {
        byKind.set(match.kind, match);
      }
    }

    return [...byKind.values()].sort(rank).slice(0, MAX_MATCHES);
  } catch {
    return [];
  }
}

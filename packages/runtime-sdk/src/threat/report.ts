/**
 * Turning detector output into wire events.
 *
 * Two things happen here that do not belong in the detector. The first is
 * working out who sent the request, which is entirely about which proxy header
 * to believe. The second is recognising a sign-in attempt, which is not an
 * attack on its own and only becomes one in volume — so this file reports the
 * attempts and the server decides when a run of them is a brute-force attack.
 */

import { normalizePathname } from '../guard/normalize.ts';
import type { ThreatEvent, ThreatMatch } from './types.ts';

/** How much of the user agent is kept. Long enough to name the tool. */
const MAX_UA = 180;

/**
 * Headers that carry the client address, most trustworthy first.
 *
 * `x-forwarded-for` is a list the caller can prepend to, so only the LAST entry
 * is added by a proxy we control — but which entry that is depends on how many
 * proxies sit in front, which we cannot know from inside the SDK. The
 * platform-specific headers are set by the platform itself and cannot be
 * spoofed from outside, so they are preferred and `x-forwarded-for` is the
 * fallback. The consequence is honest and worth stating in the UI: on a
 * self-hosted deployment behind an unknown proxy, the address is the attacker's
 * claim rather than an observation.
 */
const IP_HEADERS: ReadonlyArray<string> = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip',
  'x-vercel-forwarded-for',
  'fly-client-ip',
  'x-forwarded-for',
];

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]{3,45}$/i;

/** Accepts only something that is actually an address, so a header cannot smuggle text. */
export function parseClientIp(value: string | null | undefined): string | null {
  if (!value) return null;
  // Only the first entry of an `x-forwarded-for` chain is the original client.
  const first = value.split(',')[0]?.trim() ?? '';
  if (!first || first.length > 45) return null;
  // `::ffff:1.2.3.4` is an IPv4 address wearing an IPv6 hat.
  const unmapped = first.startsWith('::ffff:') ? first.slice(7) : first;
  if (IPV4.test(unmapped)) {
    return unmapped.split('.').every((octet) => Number(octet) <= 255) ? unmapped : null;
  }
  if (first.includes(':') && IPV6.test(first)) return first.toLowerCase();
  return null;
}

export function clientIpFrom(header: (name: string) => string | null | undefined): string | null {
  for (const name of IP_HEADERS) {
    let raw: string | null | undefined;
    try {
      raw = header(name);
    } catch {
      continue;
    }
    const ip = parseClientIp(raw);
    if (ip) return ip;
  }
  return null;
}

/**
 * Paths that take a password.
 *
 * Deliberately narrow. `/register` and `/signup` are account abuse rather than
 * password guessing, and lumping them in would put a product launch in the feed
 * next to an actual attack.
 */
const AUTH_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|session|sessions|password|passwords|authenticate)(?:$|\/)/;
/** NextAuth and friends post credentials here. */
const AUTH_CALLBACK = /^\/api\/auth\/(?:callback|signin)(?:\/|$)/;

export function isAuthAttempt(pathname: string, method: string): boolean {
  if (method !== 'POST' && method !== 'PUT') return false;
  const path = pathname.toLowerCase();
  return AUTH_PATH.test(path) || AUTH_CALLBACK.test(path);
}

/**
 * Why there is no per-source throttle here.
 *
 * An earlier version kept a bounded Map of "last reported at" per address and
 * folded bursts into one event carrying the count it swallowed. It was deleted,
 * and the reason is worth keeping: this SDK runs on serverless platforms, where
 * consecutive requests from one attacker routinely land on different instances.
 * A counter held in one process therefore throttles some requests and not
 * others, at a ratio nobody can predict — so the totals it produced were not
 * merely approximate, they were approximate by an unknown factor that changed
 * with the platform\'s autoscaling.
 *
 * Wrong numbers presented confidently are worse than more rows. Every attempt is
 * now its own event, the count is exact, and volume is bounded where it can
 * actually be bounded: the client batches, and the ingest route caps how many
 * threat events one request may carry.
 */

export type ThreatContext = {
  pathname: string;
  method: string;
  userAgent?: string | null;
  sourceIp?: string | null;
  /** What the application's own middleware did with the request. */
  blocked?: boolean;
  status?: number | null;
};

function truncateUa(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_UA) : null;
}

/** One wire event per distinct attack class the detector recognised. */
export function buildThreatEvents(matches: ReadonlyArray<ThreatMatch>, ctx: ThreatContext): ThreatEvent[] {
  // The route SHAPE, not the path. The payload is already captured as evidence;
  // sending the concrete path as well would put ids and tokens on the wire for
  // no extra detection value.
  const pattern = normalizePathname(ctx.pathname) || '/';
  const userAgent = truncateUa(ctx.userAgent);

  return matches.map((match) => ({
    type: 'threat' as const,
    kind: match.kind,
    confidence: match.confidence,
    surface: match.surface,
    ruleId: match.ruleId,
    evidence: match.evidence,
    pattern,
    method: ctx.method,
    sourceIp: ctx.sourceIp ?? null,
    userAgent,
    blocked: ctx.blocked ?? false,
    status: ctx.status ?? null,
  }));
}

/**
 * A sign-in attempt, when one is worth reporting.
 *
 * The kind is `auth_attempt`, not `auth_failure`, and the difference is the
 * point. Middleware runs before the login handler and never learns whether the
 * password was right, so calling every observation a failure would put a
 * customer's own successful logins in a feed headed "attacks". These events are
 * never shown on their own; they exist so the server can recognise the volume
 * pattern that IS an attack. An application that wants precision reports its
 * real failures with `reportAuthFailure`.
 *
 * Returns null for a path that does not take a password.
 */
export function buildAuthAttemptEvent(ctx: ThreatContext): ThreatEvent | null {
  if (!isAuthAttempt(ctx.pathname, ctx.method)) return null;

  const pattern = normalizePathname(ctx.pathname) || '/';
  return {
    type: 'threat',
    kind: 'auth_attempt',
    confidence: 'certain',
    surface: 'path',
    ruleId: 'auth.attempt',
    evidence: `Sign-in attempt to ${pattern}`,
    count: 1,
    pattern,
    method: ctx.method,
    sourceIp: ctx.sourceIp ?? null,
    userAgent: truncateUa(ctx.userAgent),
    blocked: ctx.blocked ?? false,
    status: ctx.status ?? null,
  };
}

/**
 * A sign-in the application knows failed.
 *
 * The one thing middleware cannot observe, offered as a one-line call from
 * inside a login handler:
 *
 *   if (!valid) reportAuthFailure({ request });
 *
 * Unthrottled, because a confirmed failure is rare in normal use and precious:
 * five of them from one address is a brute-force attack, where it takes twenty
 * unlabelled attempts to say the same thing.
 */
export function buildAuthFailureEvent(ctx: ThreatContext): ThreatEvent {
  const pattern = normalizePathname(ctx.pathname) || '/';
  return {
    type: 'threat',
    kind: 'auth_failure',
    confidence: 'certain',
    surface: 'path',
    ruleId: 'auth.failure',
    evidence: `Failed sign-in at ${pattern}`,
    pattern,
    method: ctx.method,
    sourceIp: ctx.sourceIp ?? null,
    userAgent: truncateUa(ctx.userAgent),
    blocked: true,
    status: ctx.status ?? 401,
  };
}

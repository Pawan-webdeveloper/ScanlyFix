import { describe, expect, it } from 'vitest';

import { detectThreats } from '../src/threat/detect.ts';
import {
  buildAuthAttemptEvent,
  buildAuthFailureEvent,
  buildThreatEvents,
  clientIpFrom,
  isAuthAttempt,
  parseClientIp,
} from '../src/threat/report.ts';

const ctx = (over: Partial<Parameters<typeof buildAuthAttemptEvent>[0]> = {}) => ({
  pathname: '/api/auth/login',
  method: 'POST',
  userAgent: 'curl/8.4.0',
  sourceIp: '203.0.113.9',
  ...over,
});

describe('parseClientIp', () => {
  it('takes the first entry of a forwarded chain', () => {
    expect(parseClientIp('203.0.113.9, 10.0.0.1, 10.0.0.2')).toBe('203.0.113.9');
  });

  it('unwraps an IPv4-mapped IPv6 address', () => {
    expect(parseClientIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('accepts IPv6', () => {
    expect(parseClientIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('refuses anything that is not an address', () => {
    // The value comes from a header the caller controls, so it is parsed rather
    // than trusted: without this, a client could write whatever it liked into
    // the column an operator reads to decide what to block.
    for (const bad of ['', '  ', 'not-an-ip', '<script>alert(1)</script>', '999.999.999.999', 'x'.repeat(60), null]) {
      expect(parseClientIp(bad)).toBeNull();
    }
  });

  it('rejects an out-of-range octet', () => {
    expect(parseClientIp('300.1.1.1')).toBeNull();
  });
});

describe('clientIpFrom', () => {
  it('prefers the platform header over the one anyone can set', () => {
    // A request can arrive carrying its own x-forwarded-for. The platform's own
    // header cannot be forged from outside, so it wins.
    const ip = clientIpFrom((name) =>
      name === 'cf-connecting-ip' ? '198.51.100.7' : name === 'x-forwarded-for' ? '1.2.3.4' : null,
    );
    expect(ip).toBe('198.51.100.7');
  });

  it('falls back to the forwarded chain', () => {
    expect(clientIpFrom((name) => (name === 'x-forwarded-for' ? '198.51.100.7, 10.0.0.1' : null))).toBe('198.51.100.7');
  });

  it('returns null rather than a guess when nothing is available', () => {
    expect(clientIpFrom(() => null)).toBeNull();
  });

  it('keeps going when a header getter throws', () => {
    const ip = clientIpFrom((name) => {
      if (name === 'cf-connecting-ip') throw new Error('boom');
      return name === 'x-real-ip' ? '198.51.100.7' : null;
    });
    expect(ip).toBe('198.51.100.7');
  });
});

describe('isAuthAttempt', () => {
  it('recognises the paths that take a password', () => {
    for (const path of ['/login', '/api/login', '/auth/sign-in', '/api/auth/callback/credentials', '/account/password']) {
      expect(isAuthAttempt(path, 'POST'), path).toBe(true);
    }
  });

  it('ignores a GET, which is the page and not the attempt', () => {
    expect(isAuthAttempt('/login', 'GET')).toBe(false);
  });

  it('leaves sign-up alone, which is a different problem', () => {
    // Account-creation abuse is real, but putting a product launch in a feed
    // headed "attacks" is how a security tool loses its reader.
    expect(isAuthAttempt('/signup', 'POST')).toBe(false);
    expect(isAuthAttempt('/api/register', 'POST')).toBe(false);
  });

  it('does not fire on an unrelated route that merely contains the word', () => {
    expect(isAuthAttempt('/blog/login-flow-redesign', 'POST')).toBe(false);
  });
});

describe('buildThreatEvents', () => {
  it('sends the route shape, never the concrete path', () => {
    const matches = detectThreats({ pathname: '/api/users/8f1c2b3d', search: "?q=1' or 1=1" });
    const [event] = buildThreatEvents(matches, ctx({ pathname: '/api/users/user@example.com' }));
    expect(event?.pattern).toBe('/api/users/[email]');
    expect(event?.pattern).not.toContain('@example.com');
  });

  it('carries the payload as evidence and the attacker as the source', () => {
    const matches = detectThreats({ pathname: '/x', search: '?q=<script>alert(1)</script>' });
    const [event] = buildThreatEvents(matches, ctx({ pathname: '/x' }));
    expect(event?.kind).toBe('xss');
    expect(event?.evidence).toContain('<script');
    expect(event?.sourceIp).toBe('203.0.113.9');
    expect(event?.type).toBe('threat');
  });

  it('truncates a user agent padded out to exhaust the column', () => {
    const [event] = buildThreatEvents(detectThreats({ pathname: '/.env' }), ctx({ userAgent: 'x'.repeat(5_000) }));
    expect(event!.userAgent!.length).toBeLessThanOrEqual(180);
  });

  it('produces nothing when nothing was found', () => {
    expect(buildThreatEvents([], ctx())).toEqual([]);
  });
});

describe('sign-in attempts', () => {
  it('reports an attempt, and calls it an attempt', () => {
    const event = buildAuthAttemptEvent(ctx());
    // Middleware runs before the login handler, so it cannot know whether the
    // password was right. Calling this a failure would put the customer's own
    // successful logins in a feed headed "attacks".
    expect(event?.kind).toBe('auth_attempt');
    expect(event?.kind).not.toBe('auth_failure');
  });

  it('ignores a path that does not take a password', () => {
    expect(buildAuthAttemptEvent(ctx({ pathname: '/api/orders' }))).toBeNull();
  });

  it('reports every attempt, so the totals are exact', () => {
    // An in-process throttle used to fold bursts together. On a serverless
    // platform consecutive requests land on different instances, so it
    // suppressed an unpredictable share of them and the counts it produced were
    // wrong by an unknown factor. Exact rows beat confident guesses.
    const events = Array.from({ length: 25 }, () => buildAuthAttemptEvent(ctx()));
    expect(events.every((e) => e !== null)).toBe(true);
    expect(events.reduce((sum, e) => sum + (e?.count ?? 0), 0)).toBe(25);
  });

  it('still reports when the platform gave us no address', () => {
    const event = buildAuthAttemptEvent(ctx({ sourceIp: null }));
    expect(event).not.toBeNull();
    expect(event?.sourceIp).toBeNull();
  });
});

describe('confirmed sign-in failures', () => {
  it('are reported as failures, unthrottled', () => {
    const a = buildAuthFailureEvent(ctx());
    const b = buildAuthFailureEvent(ctx());
    expect(a.kind).toBe('auth_failure');
    expect(b.kind).toBe('auth_failure');
    expect(a.blocked).toBe(true);
    expect(a.status).toBe(401);
  });

  it('name the route without leaking the identity that failed', () => {
    const event = buildAuthFailureEvent(ctx({ pathname: '/api/login/user@example.com' }));
    expect(event.evidence).not.toContain('@example.com');
    expect(event.pattern).toBe('/api/login/[email]');
  });
});

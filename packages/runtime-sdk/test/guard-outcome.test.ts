import { describe, expect, it } from 'vitest';

import { classifyOutcome, isPassThrough, isSignInDestination, type ResponseLike } from '../src/guard/outcome.ts';

function res(status: number, headers: Record<string, string> = {}): ResponseLike {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null } };
}

const WRAPPED = { hasUserMiddleware: true };
const BARE = { hasUserMiddleware: false };

describe('guard outcome — isSignInDestination', () => {
  it('recognises the usual sign-in paths, relative or absolute', () => {
    for (const dest of [
      '/login',
      '/signin',
      '/sign-in',
      '/auth/login',
      '/api/auth/signin',
      '/users/sign_in',
      '/account/login',
      'https://app.example.com/login?next=/admin',
      '/login?callbackUrl=%2Fdashboard',
    ]) {
      expect(isSignInDestination(dest), dest).toBe(true);
    }
  });

  it('does not treat ordinary redirects as authentication', () => {
    for (const dest of ['/dashboard', '/en/dashboard', '/new-url', '/pricing', 'https://example.com/', '/blog/post-1']) {
      expect(isSignInDestination(dest), dest).toBe(false);
    }
  });

  it('reads only the path, so a query string mentioning login cannot fake it', () => {
    expect(isSignInDestination('/dashboard?from=/login')).toBe(false);
    expect(isSignInDestination('/search?q=how+to+login')).toBe(false);
  });

  it('handles missing and unparseable values without throwing', () => {
    expect(isSignInDestination(null)).toBe(false);
    expect(isSignInDestination(undefined)).toBe(false);
    expect(isSignInDestination('')).toBe(false);
    expect(isSignInDestination('::::not a url::::')).toBe(false);
  });
});

describe('guard outcome — classifyOutcome', () => {
  it('reads an explicit auth challenge as blocked', () => {
    expect(classifyOutcome(res(401), WRAPPED)).toBe('blocked');
    expect(classifyOutcome(res(403), WRAPPED)).toBe('blocked');
  });

  it('reads a redirect to sign-in as blocked, and any other redirect as unknown', () => {
    expect(classifyOutcome(res(307, { location: '/login?next=/admin' }), WRAPPED)).toBe('blocked');
    expect(classifyOutcome(res(302, { location: 'https://app.test/auth/signin' }), WRAPPED)).toBe('blocked');
    // A locale prefix or a renamed URL is not an auth decision.
    expect(classifyOutcome(res(308, { location: '/en/dashboard' }), WRAPPED)).toBe('unknown');
    expect(classifyOutcome(res(307, {}), WRAPPED)).toBe('unknown');
  });

  it('reads a rewrite to the sign-in page as blocked', () => {
    expect(classifyOutcome(res(200, { 'x-middleware-rewrite': '/login' }), WRAPPED)).toBe('blocked');
    expect(classifyOutcome(res(200, { 'x-middleware-rewrite': '/en/dashboard' }), WRAPPED)).toBe('passed');
  });

  it('reads a pass-through as passed', () => {
    expect(classifyOutcome(res(200, { 'x-middleware-next': '1' }), WRAPPED)).toBe('passed');
    expect(classifyOutcome(res(204), WRAPPED)).toBe('passed');
  });

  it('refuses to guess when there is no middleware to observe', () => {
    // withGuard() with no wrapped middleware always returns NextResponse.next().
    // Calling that "passed" would mark every route in the app unenforced.
    expect(classifyOutcome(res(200, { 'x-middleware-next': '1' }), BARE)).toBe('unknown');
    expect(classifyOutcome(res(401), BARE)).toBe('unknown');
  });

  it('says nothing about authentication when the request simply failed', () => {
    for (const status of [400, 404, 429, 500, 502, 503]) {
      expect(classifyOutcome(res(status), WRAPPED), String(status)).toBe('unknown');
    }
  });

  it('never throws on a missing or hostile response object', () => {
    expect(classifyOutcome(null, WRAPPED)).toBe('unknown');
    expect(classifyOutcome(undefined, WRAPPED)).toBe('unknown');
    expect(classifyOutcome({ status: 307 } as unknown as ResponseLike, WRAPPED)).toBe('unknown');
    const throwing = {
      status: 302,
      headers: {
        get() {
          throw new Error('headers are sealed');
        },
      },
    } as unknown as ResponseLike;
    expect(classifyOutcome(throwing, WRAPPED)).toBe('unknown');
  });
});

describe('guard outcome — isPassThrough', () => {
  it('detects the NextResponse.next() marker', () => {
    expect(isPassThrough(res(200, { 'x-middleware-next': '1' }))).toBe(true);
    expect(isPassThrough(res(200))).toBe(false);
    expect(isPassThrough(null)).toBe(false);
  });
});

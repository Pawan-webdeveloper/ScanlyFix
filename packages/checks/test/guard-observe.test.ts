import { describe, expect, it } from 'vitest';

import { buildRouteEvent } from '../src/guard/observe.ts';
import { hasSessionCookie } from '../src/guard/session.ts';

describe('buildRouteEvent', () => {
  it('server action header → kind server_action', () => {
    const e = buildRouteEvent({ pathname: '/dashboard', method: 'POST', isServerAction: true });
    expect(e?.kind).toBe('server_action');
    expect(e?.method).toBe('POST');
  });

  it('supabase chunked cookie NAME se detect hota hai', () => {
    const e = buildRouteEvent({
      pathname: '/api/secret',
      method: 'GET',
      cookieHeader: 'sb-abcd1234-auth-token.0=NOT-READ; other=x',
    });
    expect(e?.hasSession).toBe(true);
  });

  it('bina session → false', () => {
    const e = buildRouteEvent({ pathname: '/api/secret', method: 'GET', cookieHeader: 'theme=dark' });
    expect(e?.hasSession).toBe(false);
  });

  it('extraCookieNames custom session pakadta hai', () => {
    const e = buildRouteEvent(
      { pathname: '/app', method: 'GET', cookieHeader: 'my-session=whatever' },
      { extraCookieNames: ['my-session'] },
    );
    expect(e?.hasSession).toBe(true);
  });

  it('root aur unknown method → null', () => {
    expect(buildRouteEvent({ pathname: '/', method: 'GET' })).toBeNull();
    expect(buildRouteEvent({ pathname: '/x', method: 'BREW' })).toBeNull();
  });

  it('middleware events me status/durationMs absent hote hain', () => {
    const e = buildRouteEvent({ pathname: '/a', method: 'GET' });
    expect(e?.status).toBeUndefined();
    expect(e?.durationMs).toBeUndefined();
  });
});

describe('hasSessionCookie', () => {
  it('cookie VALUE kabhi parse nahi hota — sirf naam', () => {
    expect(hasSessionCookie('sb-x-auth-token=eyJhbGciOi.payload')).toBe(true);
    // value me cookie-jaisa string ho to bhi naam hi matter karta hai:
    expect(hasSessionCookie('random=sb-x-auth-token-like-value')).toBe(false);
  });
});
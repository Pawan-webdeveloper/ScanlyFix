/**
 * The wrapper's contract under the outcome change: it must run the user's
 * middleware, return its response untouched, record what that response was,
 * and never turn a telemetry problem into an application failure.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

import { withGuard, type NextRequestLike } from '../src/guard/middleware.ts';
import type { RouteEvent } from '../src/guard/observe.ts';
import { createRuntime, type RuntimeClient } from '../src/runtime.ts';

function makeRequest(pathname: string, options: { method?: string; cookies?: string; isServerAction?: boolean } = {}): NextRequestLike {
  const headers = new Map<string, string>();
  if (options.cookies) headers.set('cookie', options.cookies);
  if (options.isServerAction) headers.set('next-action', '1');
  return {
    nextUrl: { pathname },
    method: options.method ?? 'GET',
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => headers.has(name.toLowerCase()),
    },
  };
}

function makeRuntime(): { runtime: RuntimeClient; events: RouteEvent[] } {
  const events: RouteEvent[] = [];
  const runtime = createRuntime({ projectId: 'p', ingestUrl: 'http://localhost/api/runtime/ingest' });
  vi.spyOn(runtime, 'report').mockImplementation((e) => {
    events.push(e as RouteEvent);
  });
  vi.spyOn(runtime, 'flush').mockResolvedValue();
  return { runtime, events };
}

const SESSION_COOKIE = 'sb-abc-auth-token=xyz';

describe('withGuard — recording the middleware decision', () => {
  it('records blocked when the wrapped middleware redirects a logged-out visitor to sign-in', async () => {
    const { runtime, events } = makeRuntime();
    const auth = vi.fn().mockResolvedValue(NextResponse.redirect('https://app.test/login?next=/admin'));

    const middleware = withGuard(auth, { runtime });
    await middleware(makeRequest('/admin'));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ pattern: '/admin', hasSession: false, outcome: 'blocked', status: 307 });
  });

  it('records blocked on a 401 from the wrapped middleware', async () => {
    const { runtime, events } = makeRuntime();
    const auth = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));

    await withGuard(auth, { runtime })(makeRequest('/api/orders'));

    expect(events[0]).toMatchObject({ pattern: '/api/orders', outcome: 'blocked', status: 401 });
  });

  it('records passed when the wrapped middleware waves a logged-out request through', async () => {
    const { runtime, events } = makeRuntime();
    const auth = vi.fn().mockResolvedValue(NextResponse.next());

    await withGuard(auth, { runtime })(makeRequest('/admin/users'));

    expect(events[0]).toMatchObject({ pattern: '/admin/users', hasSession: false, outcome: 'passed' });
  });

  it('records no outcome at all when there is no middleware to observe', async () => {
    const { runtime, events } = makeRuntime();

    await withGuard(undefined, { runtime })(makeRequest('/dashboard'));

    expect(events).toHaveLength(1);
    expect(events[0]?.pattern).toBe('/dashboard');
    // An absent field reads as "no data" downstream — never as a pass-through.
    expect(events[0]?.outcome).toBeUndefined();
    expect(events[0]?.status).toBeUndefined();
  });

  it('returns the wrapped middleware response unchanged', async () => {
    const { runtime } = makeRuntime();
    const custom = new Response('custom auth redirect', { status: 302, headers: { location: '/login' } });
    const auth = vi.fn().mockResolvedValue(custom);

    const res = await withGuard(auth, { runtime })(makeRequest('/api/protected'));

    expect(res).toBe(custom);
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it('still reports the session cookie and the server-action flag', async () => {
    const { runtime, events } = makeRuntime();
    const auth = vi.fn().mockResolvedValue(NextResponse.next());

    await withGuard(auth, { runtime })(
      makeRequest('/api/update-profile', { method: 'POST', cookies: SESSION_COOKIE, isServerAction: true }),
    );

    expect(events[0]).toMatchObject({
      pattern: '/api/update-profile',
      method: 'POST',
      kind: 'server_action',
      hasSession: true,
      outcome: 'passed',
    });
  });

  it('lets a middleware error propagate, and still records the observation', async () => {
    const { runtime, events } = makeRuntime();
    const boom = new Error('middleware blew up');
    const auth = vi.fn().mockRejectedValue(boom);

    await expect(withGuard(auth, { runtime })(makeRequest('/dashboard'))).rejects.toThrow('middleware blew up');
    // A crash says nothing about authentication.
    expect(events[0]).toMatchObject({ pattern: '/dashboard' });
    expect(events[0]?.outcome).toBeUndefined();
  });

  it('never fails the request when telemetry throws', async () => {
    const runtime = createRuntime({ projectId: 'p', ingestUrl: 'http://localhost/api/runtime/ingest' });
    vi.spyOn(runtime, 'report').mockImplementation(() => {
      throw new Error('queue exploded');
    });
    vi.spyOn(runtime, 'flush').mockResolvedValue();
    const auth = vi.fn().mockResolvedValue(NextResponse.next());

    const res = await withGuard(auth, { runtime })(makeRequest('/dashboard'));
    expect(res).toBeDefined();
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it('never fails the request when the flush promise rejects', async () => {
    const runtime = createRuntime({ projectId: 'p', ingestUrl: 'http://localhost/api/runtime/ingest' });
    vi.spyOn(runtime, 'report').mockImplementation(() => {});
    vi.spyOn(runtime, 'flush').mockReturnValue(Promise.reject(new Error('ingest down')));
    const auth = vi.fn().mockResolvedValue(NextResponse.next());

    const res = await withGuard(auth, { runtime })(makeRequest('/dashboard'));
    expect(res).toBeDefined();
    // Give the rejection a tick to surface as unhandled if it were not caught.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('still skips excluded paths and never calls report for them', async () => {
    const { runtime, events } = makeRuntime();
    const auth = vi.fn().mockResolvedValue(NextResponse.next());
    const middleware = withGuard(auth, { runtime });

    for (const path of ['/', '/_next/static/chunk.js', '/favicon.ico', '/api/runtime/ingest']) {
      await middleware(makeRequest(path));
    }

    expect(events).toHaveLength(0);
    // Exclusion is about telemetry only — the app's middleware still runs.
    expect(auth).toHaveBeenCalledTimes(4);
  });

  it('honours a custom exclude predicate while still running the middleware', async () => {
    const { runtime, events } = makeRuntime();
    const auth = vi.fn().mockResolvedValue(NextResponse.next());
    const middleware = withGuard(auth, { runtime, exclude: (p) => p.startsWith('/health') });

    await middleware(makeRequest('/health/live'));
    await middleware(makeRequest('/dashboard'));

    expect(events.map((e) => e.pattern)).toEqual(['/dashboard']);
    expect(auth).toHaveBeenCalledTimes(2);
  });
});

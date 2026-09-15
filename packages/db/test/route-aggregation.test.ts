import { describe, expect, it } from 'vitest';

import {
  aggregateRouteEvents,
  routeEventKey,
  type IngestRouteEvent,
} from '../src/queries/route-aggregation.ts';

const ev = (overrides: Partial<IngestRouteEvent> = {}): IngestRouteEvent => ({
  pattern: '/dashboard',
  method: 'GET',
  hasSession: true,
  ...overrides,
});

describe('aggregateRouteEvents', () => {
  it('collapses a batch into one row per route', () => {
    const totals = aggregateRouteEvents([
      ev(),
      ev(),
      ev({ hasSession: false, outcome: 'blocked' }),
      ev({ pattern: '/pricing', hasSession: false, outcome: 'passed' }),
    ]);

    expect(totals.size).toBe(2);
    const dashboard = totals.get(routeEventKey('/dashboard', 'GET'))!;
    expect(dashboard).toMatchObject({
      pattern: '/dashboard',
      method: 'GET',
      withSession: 2,
      withoutSession: 1,
      withoutSessionBlocked: 1,
      withoutSessionPassed: 0,
    });
  });

  it('counts the outcome breakdown ONLY when the decision was observed', () => {
    const totals = aggregateRouteEvents([
      ev({ hasSession: false, outcome: 'blocked' }),
      ev({ hasSession: false, outcome: 'passed' }),
      ev({ hasSession: false, outcome: 'unknown' }),
      ev({ hasSession: false }), // no outcome at all
    ]);

    const row = totals.get(routeEventKey('/dashboard', 'GET'))!;
    expect(row.withoutSession).toBe(4);
    // The two unobserved requests are counted in the total and nowhere else —
    // assuming either way would manufacture evidence.
    expect(row.withoutSessionBlocked).toBe(1);
    expect(row.withoutSessionPassed).toBe(1);
    expect(row.withoutSessionBlocked + row.withoutSessionPassed).toBeLessThanOrEqual(row.withoutSession);
  });

  it('never lets an outcome on a signed-in request touch the breakdown', () => {
    const totals = aggregateRouteEvents([
      ev({ hasSession: true, outcome: 'passed' }),
      ev({ hasSession: true, outcome: 'blocked' }),
    ]);
    const row = totals.get(routeEventKey('/dashboard', 'GET'))!;
    expect(row.withSession).toBe(2);
    expect(row.withoutSession).toBe(0);
    expect(row.withoutSessionBlocked).toBe(0);
    expect(row.withoutSessionPassed).toBe(0);
  });

  it('treats method case-insensitively but keeps one canonical row', () => {
    const totals = aggregateRouteEvents([ev({ method: 'get' }), ev({ method: 'GET' }), ev({ method: 'Get' })]);
    expect(totals.size).toBe(1);
    expect(totals.get(routeEventKey('/dashboard', 'GET'))!.withSession).toBe(3);
    expect(totals.get(routeEventKey('/dashboard', 'GET'))!.method).toBe('GET');
  });

  it('keeps separate rows per method, because a GET and a POST are different surfaces', () => {
    const totals = aggregateRouteEvents([ev({ method: 'GET' }), ev({ method: 'POST' })]);
    expect(totals.size).toBe(2);
  });

  it('never demotes a server action back to a plain route', () => {
    const asAction = aggregateRouteEvents([
      ev({ pattern: '/api/save', method: 'POST', kind: 'server_action' }),
      ev({ pattern: '/api/save', method: 'POST', kind: 'route' }),
    ]);
    expect(asAction.get(routeEventKey('/api/save', 'POST'))!.kind).toBe('server_action');

    // …in either arrival order.
    const reversed = aggregateRouteEvents([
      ev({ pattern: '/api/save', method: 'POST', kind: 'route' }),
      ev({ pattern: '/api/save', method: 'POST', kind: 'server_action' }),
    ]);
    expect(reversed.get(routeEventKey('/api/save', 'POST'))!.kind).toBe('server_action');
  });

  it('defaults kind to route and skips malformed events', () => {
    const totals = aggregateRouteEvents([
      ev(),
      { pattern: '', method: 'GET', hasSession: true },
      { pattern: '/x', method: '', hasSession: true },
    ]);
    expect(totals.size).toBe(1);
    expect(totals.get(routeEventKey('/dashboard', 'GET'))!.kind).toBe('route');
  });

  it('returns an empty map for an empty batch', () => {
    expect(aggregateRouteEvents([]).size).toBe(0);
  });
});

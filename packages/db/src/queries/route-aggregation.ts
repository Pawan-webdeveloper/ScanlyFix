/**
 * Collapsing raw route observations into per-route counters.
 *
 * Pure and dependency-free on purpose: this is the counting rule at the heart
 * of Guard, and it should be testable — and reusable — without a database
 * connection.
 */

/** What the caller's middleware did with a logged-out request. */
export type RouteOutcome = 'blocked' | 'passed' | 'unknown';

export type IngestRouteEvent = {
  pattern: string;
  method: string;
  kind?: string;
  hasSession: boolean;
  /** Only meaningful when hasSession is false — see runtime-sdk guard/outcome.ts. */
  outcome?: RouteOutcome;
};

/** One route's totals within a batch. */
export type RouteEventTotals = {
  pattern: string;
  method: string;
  kind: string;
  withSession: number;
  withoutSession: number;
  withoutSessionBlocked: number;
  withoutSessionPassed: number;
};

/** Stable identity of a route within a batch. */
export function routeEventKey(pattern: string, method: string): string {
  return `${pattern}::${method.toUpperCase()}`;
}

/**
 * Collapses a batch of individual observations into one row per route.
 *
 * The rule worth stating: a logged-out request contributes to the blocked or
 * passed breakdown ONLY when the middleware's decision was actually observed.
 * An 'unknown' outcome is counted in `withoutSession` and nowhere else —
 * guessing either way would manufacture evidence that does not exist.
 *
 * `kind` takes the strongest value seen for the route: once a pattern has been
 * observed as a server action, a later plain request must not demote it.
 */
export function aggregateRouteEvents(events: ReadonlyArray<IngestRouteEvent>): Map<string, RouteEventTotals> {
  const totals = new Map<string, RouteEventTotals>();

  for (const e of events) {
    if (!e.pattern || !e.method) continue;
    const method = e.method.toUpperCase();
    const key = routeEventKey(e.pattern, method);

    const acc: RouteEventTotals = totals.get(key) ?? {
      pattern: e.pattern,
      method,
      kind: 'route',
      withSession: 0,
      withoutSession: 0,
      withoutSessionBlocked: 0,
      withoutSessionPassed: 0,
    };

    if (e.kind === 'server_action') acc.kind = 'server_action';
    else if (e.kind && acc.kind === 'route') acc.kind = e.kind;

    if (e.hasSession) {
      acc.withSession += 1;
    } else {
      acc.withoutSession += 1;
      if (e.outcome === 'blocked') acc.withoutSessionBlocked += 1;
      else if (e.outcome === 'passed') acc.withoutSessionPassed += 1;
    }

    totals.set(key, acc);
  }

  return totals;
}

import { normalizePathname } from './normalize.ts';
import type { RouteOutcome } from './outcome.ts';
import { hasSessionCookie, type SessionDetectionOptions } from './session.ts';

export type RouteEvent = {
  type: 'route';
  pattern: string;
  method: string;
  kind: 'route' | 'server_action';
  hasSession: boolean;
  /**
   * What the wrapped middleware did with this request. 'unknown' when there is
   * no middleware to observe — see outcome.ts for why that distinction matters.
   */
  outcome?: RouteOutcome;
  /** Status the middleware returned, when one was observed. Never a body, never a header value. */
  status?: number;
  durationMs?: number;
};

/** Framework-agnostic snapshot — tests ko Request object ki zaroorat nahi. */
export type RequestSnapshot = {
  pathname: string;
  method: string;
  cookieHeader?: string | null;
  isServerAction?: boolean;
};

const KNOWN_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export type BuildRouteEventOptions = SessionDetectionOptions & {
  outcome?: RouteOutcome;
  status?: number;
};

export function buildRouteEvent(snapshot: RequestSnapshot, opts: BuildRouteEventOptions = {}): RouteEvent | null {
  const pattern = normalizePathname(snapshot.pathname);
  if (pattern.length === 0 || pattern === '/') return null; // root har app me hai — noise

  const method = snapshot.method.toUpperCase();
  if (!KNOWN_METHODS.has(method)) return null; // custom methods server pe reject honge, yahin drop

  const event: RouteEvent = {
    type: 'route',
    pattern,
    method,
    kind: snapshot.isServerAction ? 'server_action' : 'route',
    hasSession: hasSessionCookie(snapshot.cookieHeader, opts),
  };

  // Only carried when actually observed — an absent field reads as "no data"
  // downstream, which is different from "unknown outcome recorded".
  if (opts.outcome && opts.outcome !== 'unknown') event.outcome = opts.outcome;
  if (typeof opts.status === 'number' && Number.isInteger(opts.status) && opts.status > 0) {
    event.status = opts.status;
  }

  return event;
}

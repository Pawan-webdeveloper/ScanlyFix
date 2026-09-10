import { normalizePathname } from './normalize.ts';
import { hasSessionCookie, type SessionDetectionOptions } from './session.ts';

export type RouteEvent = {
  type: 'route';
  pattern: string;
  method: string;
  kind: 'route' | 'server_action';
  hasSession: boolean;
  status?: number;
  durationMs?: number;
};

/** Framework-agnostic snapshot */
export type RequestSnapshot = {
  pathname: string;
  method: string;
  cookieHeader?: string | null;
  isServerAction?: boolean;
};

const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

export function buildRouteEvent(
  snapshot: RequestSnapshot,
  opts: SessionDetectionOptions = {},
): RouteEvent | null {
  const pattern = normalizePathname(snapshot.pathname);
  if (pattern.length === 0 || pattern === '/') return null;

  const method = snapshot.method.toUpperCase();
  if (!KNOWN_METHODS.has(method)) return null;

  return {
    type: 'route',
    pattern,
    method,
    kind: snapshot.isServerAction ? 'server_action' : 'route',
    hasSession: hasSessionCookie(snapshot.cookieHeader, opts),
  };
}

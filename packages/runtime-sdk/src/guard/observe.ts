export type RouteEvent = {
  type: 'route';
  pattern: string;
  method: string;
  kind: 'route' | 'server_action';
  hasSession: boolean;
  status?: number;
  durationMs?: number;
};

import { normalizePathname } from './normalize.ts';
import { hasSessionCookie, type SessionDetectionOptions } from './session.ts';

/** Framework-agnostic snapshot — tests ko Request object ki zaroorat nahi. */
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
  if (pattern.length === 0 || pattern === '/') return null; // root har app me hai — noise

  const method = snapshot.method.toUpperCase();
  if (!KNOWN_METHODS.has(method)) return null; // custom methods server pe reject honge, yahin drop

  return {
    type: 'route',
    pattern,
    method,
    kind: snapshot.isServerAction ? 'server_action' : 'route',
    hasSession: hasSessionCookie(snapshot.cookieHeader, opts),
    // status/durationMs jaan-boojh ke absent — middleware inhe nahi dekh sakta
  };
}
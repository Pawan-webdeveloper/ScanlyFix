import { MAX_TARGETS_PER_PROJECT, type TargetCategory } from './types';

export type TargetSpec = { path: string; category: TargetCategory };

/**
 * Routes probed on every project by default, grouped the way CheckVibe groups
 * its access-control scanners: admin panels, unauthenticated APIs, debug/dev
 * endpoints left in production, and ordinary logged-in pages.
 *
 * Kept deliberately modest — every entry is one request to somebody else's
 * server every night. Sensitive *files* (/.env, /.git) are already covered by
 * the one-shot site scan and are not duplicated here.
 */
export const DEFAULT_PROBER_TARGET_SPECS: ReadonlyArray<TargetSpec> = [
  // Control panels
  { path: '/admin', category: 'admin' },
  { path: '/admin/dashboard', category: 'admin' },
  { path: '/admin/users', category: 'admin' },
  { path: '/admin/settings', category: 'admin' },
  { path: '/internal', category: 'admin' },
  { path: '/console', category: 'admin' },
  { path: '/manage', category: 'admin' },
  { path: '/wp-admin', category: 'admin' },

  // Logged-in pages
  { path: '/dashboard', category: 'auth_page' },
  { path: '/app', category: 'auth_page' },
  { path: '/account', category: 'auth_page' },
  { path: '/profile', category: 'auth_page' },
  { path: '/settings', category: 'auth_page' },
  { path: '/settings/billing', category: 'auth_page' },
  { path: '/billing', category: 'auth_page' },
  { path: '/orders', category: 'auth_page' },

  // Data endpoints
  { path: '/api/me', category: 'api' },
  { path: '/api/user', category: 'api' },
  { path: '/api/users', category: 'api' },
  { path: '/api/users/[id]', category: 'api' },
  { path: '/api/admin', category: 'api' },
  { path: '/api/admin/users', category: 'api' },
  { path: '/api/account', category: 'api' },
  { path: '/api/profile', category: 'api' },
  { path: '/api/orders', category: 'api' },
  { path: '/api/internal', category: 'api' },
  { path: '/api/export', category: 'api' },
  { path: '/graphql', category: 'api' },

  // Dev / debug tooling
  { path: '/debug', category: 'debug' },
  { path: '/api/debug', category: 'debug' },
  { path: '/_debug', category: 'debug' },
  { path: '/actuator', category: 'debug' },
  { path: '/actuator/env', category: 'debug' },
  { path: '/metrics', category: 'debug' },
  { path: '/phpinfo.php', category: 'debug' },
  { path: '/server-status', category: 'debug' },
  { path: '/swagger', category: 'debug' },
  { path: '/api-docs', category: 'debug' },
  { path: '/openapi.json', category: 'debug' },
];

/** Backwards-compatible flat list (paths only). */
export const DEFAULT_PROBER_TARGETS: ReadonlyArray<string> = DEFAULT_PROBER_TARGET_SPECS.map((t) => t.path);

const DEFAULT_CATEGORY_BY_PATH: ReadonlyMap<string, TargetCategory> = new Map(
  DEFAULT_PROBER_TARGET_SPECS.map((t) => [t.path, t.category]),
);

const DEBUG_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/(_+)?debug(\/|$)/i,
  /^\/api\/debug(\/|$)/i,
  /^\/actuator(\/|$)/i,
  /^\/metrics(\/|$)/i,
  /^\/phpinfo/i,
  /^\/server-(status|info)(\/|$)/i,
  /^\/swagger/i,
  /^\/api-docs(\/|$)/i,
  /^\/openapi\.(json|yaml|yml)$/i,
  /^\/(_next\/)?__(debug|dev)/i,
  /^\/(trace|health\/details|env)(\/|$)/i,
];

const ADMIN_PATTERNS: ReadonlyArray<RegExp> = [
  /^\/admin(\/|$)/i,
  /^\/internal(\/|$)/i,
  /^\/console(\/|$)/i,
  /^\/manage(ment)?(\/|$)/i,
  /^\/wp-admin(\/|$)/i,
  /^\/superuser(\/|$)/i,
  /^\/staff(\/|$)/i,
];

const API_PATTERNS: ReadonlyArray<RegExp> = [/^\/api\//i, /^\/graphql(\/|$)/i, /^\/rest\//i, /^\/v[0-9]+\//i, /^\/trpc(\/|$)/i];

/**
 * Pure: which class of surface a path belongs to. Used for severity,
 * exposure rules and UI grouping. Unknown paths are ordinary logged-in pages.
 */
export function categorizePath(path: string): TargetCategory {
  const known = DEFAULT_CATEGORY_BY_PATH.get(path);
  if (known) return known;
  if (DEBUG_PATTERNS.some((re) => re.test(path))) return 'debug';
  if (ADMIN_PATTERNS.some((re) => re.test(path))) return 'admin';
  if (API_PATTERNS.some((re) => re.test(path))) return 'api';
  return 'auth_page';
}

export const CATEGORY_LABEL: Readonly<Record<TargetCategory, string>> = {
  admin: 'Admin panel',
  api: 'API endpoint',
  debug: 'Debug endpoint',
  auth_page: 'Logged-in page',
};

export function defaultTargetsForSeeding(): Array<{ path: string; method: 'GET'; source: 'default' }> {
  return DEFAULT_PROBER_TARGET_SPECS.slice(0, MAX_TARGETS_PER_PROJECT).map((t) => ({
    path: t.path,
    method: 'GET',
    source: 'default',
  }));
}

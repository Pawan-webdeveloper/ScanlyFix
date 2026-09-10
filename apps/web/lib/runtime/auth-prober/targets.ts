import { MAX_TARGETS_PER_PROJECT } from './types';

/**
 * Common routes that typically require authentication.
 * Guard package can augment or replace these with discovered application routes.
 */
export const DEFAULT_PROBER_TARGETS: ReadonlyArray<string> = [
  '/admin',
  '/admin/dashboard',
  '/dashboard',
  '/app',
  '/console',
  '/account',
  '/profile',
  '/settings',
  '/settings/billing',
  '/billing',
  '/internal',
  '/api/me',
  '/api/users',
  '/api/admin',
  '/api/account',
  '/api/profile',
];

export function defaultTargetsForSeeding(): Array<{ path: string; method: 'GET'; source: 'default' }> {
  return DEFAULT_PROBER_TARGETS.slice(0, MAX_TARGETS_PER_PROJECT).map((path) => ({
    path,
    method: 'GET',
    source: 'default',
  }));
}

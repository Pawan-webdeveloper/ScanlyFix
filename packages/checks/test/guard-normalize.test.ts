import { describe, expect, it } from 'vitest';

import { normalizePathname } from '../src/guard/normalize.ts';

describe('normalizePathname', () => {
  it('clean path as-is rehta hai (file-tree spelling)', () => {
    expect(normalizePathname('/api/users')).toBe('/api/users');
    expect(normalizePathname('/dashboard/settings/billing')).toBe('/dashboard/settings/billing');
  });

  it('UUIDs → [id]', () => {
    expect(normalizePathname('/api/users/8f3a2b1c-1234-4abc-9def-111122223333')).toBe('/api/users/[id]');
  });

  it('numeric ids → [id]', () => {
    expect(normalizePathname('/posts/42/comments/7')).toBe('/posts/[id]/comments/[id]');
  });

  it('reset tokens → [token] — kabhi leak nahi', () => {
    expect(normalizePathname('/reset/aB3xY9kL2mN8pQ4rS6tU8vW0')).toBe('/reset/[token]');
  });

  it('emails → [email] placeholder', () => {
    expect(normalizePathname('/unsubscribe/user@example.com')).toBe('/unsubscribe/[email]');
  });

  it('query string AUR hash kabhi survive nahi karte', () => {
    expect(normalizePathname('/search?q=secret+query&token=abc')).toBe('/search');
    expect(normalizePathname('/page#section-with-data')).toBe('/page');
  });

  it('trailing + double slash normalize', () => {
    expect(normalizePathname('/api/users/')).toBe('/api/users');
    expect(normalizePathname('//api///users')).toBe('/api/users');
  });

  it('encoded segment: safe charset nahi → [token]', () => {
    // %20 decode hoke space banega — space pattern me allowed NAHI hai, isliye [token]
    expect(normalizePathname('/hello%20world')).toBe('/[token]');
    expect(normalizePathname('/%zz')).toBe('/[token]');
  });

  it('Next.js style literal brackets preserve hote hain', () => {
    expect(normalizePathname('/projects/[projectId]/settings')).toBe('/projects/[projectId]/settings');
  });

  it('root → "/" (observe isko drop karega), invalid → ""', () => {
    expect(normalizePathname('/')).toBe('/');
    expect(normalizePathname('not-a-path')).toBe('');
  });
});
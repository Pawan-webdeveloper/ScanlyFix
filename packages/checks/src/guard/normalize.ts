/**
 * Concrete request path → stable route pattern.
 *
 * PROMISE: never full URL, never query string, never id/email/token.
 * Only the shape representing the file-tree route pattern:
 *   /api/users/[id]
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 20+ chars opaque segment = reset token / share link / cuid */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;
/** Safe chars allowed in patterns */
const SAFE_SEG_RE = /^[A-Za-z0-9._~@[\]-]+$/;

const MAX_PATTERN_LENGTH = 200;

export function normalizePathname(raw: string): string {
  if (!raw || !raw.startsWith('/')) return '';
  // Collapse leading slashes so URL doesn't treat '//host/path' as a host
  const sanitized = raw.replace(/^\/{2,}/, '/');

  let path: string;
  try {
    path = new URL(sanitized, 'https://guard.internal').pathname;
  } catch {
    return '';
  }
  if (!path.startsWith('/')) return '';

  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');

  const segments = path.split('/').map((seg) => {
    if (seg === '') return seg;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return '[token]';
    }
    if (UUID_RE.test(decoded) || NUMERIC_RE.test(decoded)) return '[id]';
    if (EMAIL_RE.test(decoded)) return '[email]';
    if (TOKEN_RE.test(decoded)) return '[token]';
    if (!SAFE_SEG_RE.test(decoded)) return '[token]';
    return decoded;
  });

  return segments.join('/').slice(0, MAX_PATTERN_LENGTH);
}

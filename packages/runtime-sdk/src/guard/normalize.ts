/**
 * Concrete request path → stable route pattern.
 *
 * PROMISE (CheckVibe parity): kabhi full URL nahi, kabhi query string nahi,
 * kabhi id/email/reset-token nahi — sirf wahi shape jo file tree bolti hai:
 *   /api/users/[id]
 *
 * Design: WHITELIST, blacklist nahi. Jo segment safe charset me fit nahi
 * hota wo '[token]' ban jata hai. "Filter out" fail-unsafe hota hai;
 * "replace" fail-safe hai — kuch bhi galat ho, safe placeholder hi jayega.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 20+ chars opaque segment = reset token / share link / cuid */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,}$/;
/** Sirf ye chars pattern me survive karte hain — server validator bhi yahi allow karta hai */
const SAFE_SEG_RE = /^[A-Za-z0-9._~@[\]-]+$/;

const MAX_PATTERN_LENGTH = 200;

export function normalizePathname(raw: string): string {
  if (!raw || !raw.startsWith('/')) return '';
  const sanitized = raw.replace(/^\/{2,}/, '/');

  let path: string;
  try {
    // Query string + hash STRUCTURALLY yahin gir jaate hain — string tricks nahi.
    path = new URL(sanitized, 'https://guard.internal').pathname;
  } catch {
    return '';
  }
  if (!path.startsWith('/')) return '';

  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, ''); // trailing slash, root chhod ke

  const segments = path.split('/').map((seg) => {
    if (seg === '') return seg;
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return '[token]'; // malformed encoding (%zz) — crash nahi, leak nahi
    }
    if (UUID_RE.test(decoded) || NUMERIC_RE.test(decoded)) return '[id]';
    if (EMAIL_RE.test(decoded)) return '[email]'; // placeholder jayega, email kabhi nahi
    if (TOKEN_RE.test(decoded)) return '[token]';
    if (!SAFE_SEG_RE.test(decoded)) return '[token]'; // spaces, unicode, weird chars
    return decoded;
  });

  return segments.join('/').slice(0, MAX_PATTERN_LENGTH);
}
/**
 * Where honeytoken callbacks point.
 *
 * This value is baked into a decoy payload that is then written into the
 * customer's production database, so it has to be right the first time — the
 * row is planted by hand in a SQL console and nobody goes back to edit it.
 * Falling back to `localhost:3000`, which is what used to happen when
 * NEXT_PUBLIC_APP_URL was unset, bakes a permanently dead URL into a customer's
 * database and silently disables exfiltration detection for that project.
 *
 * So a missing value is an error here rather than a default.
 */
export function honeytokenOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (raw) {
    const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (host.length > 0 && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) return host;
    // A local origin is fine in development and nowhere else.
    if (process.env.NODE_ENV !== 'production') return host;
  }
  if (process.env.NODE_ENV !== 'production') return 'localhost:3000';
  throw new Error(
    'NEXT_PUBLIC_APP_URL is not set to a public origin. Honeytoken URLs are written into the customer database and cannot point at localhost.',
  );
}

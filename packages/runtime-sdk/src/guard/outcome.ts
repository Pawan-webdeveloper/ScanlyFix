/**
 * What the middleware DID to a request — the difference between a weak signal
 * and hard evidence.
 *
 * Guard observes requests at the edge, before the application's auth check
 * runs. So "a logged-out request arrived at /admin" says nothing on its own:
 * every protected route receives logged-out traffic from bots, stale links and
 * expired sessions, and the middleware is exactly where that traffic is
 * supposed to be turned away.
 *
 * What IS evidence is the response the middleware produced. When `withGuard`
 * wraps a real middleware, the wrapper holds that response, and:
 *
 *   'blocked'  — the middleware answered 401/403 or redirected to a sign-in
 *                page. PROOF the route is enforced at the edge for this request.
 *   'passed'   — the middleware waved the request through. NOT proof of a hole
 *                (auth may still run in the handler), but a route whose
 *                logged-out requests sometimes block and sometimes pass has a
 *                genuine gap, and that comparison is only possible here.
 *   'unknown'  — nothing to learn: no user middleware was wrapped, so the
 *                response is always a pass-through by construction.
 *
 * Every predicate here is pure and framework-agnostic, so the classification
 * is testable without constructing a Next.js response.
 */

export type RouteOutcome = 'blocked' | 'passed' | 'unknown';

/**
 * Path prefixes/segments that mean "you are being asked to authenticate".
 * Matched against the redirect destination's PATH only — never its query
 * string, which routinely carries the original URL and can contain anything.
 */
const SIGN_IN_PATH = /(^|\/)(login|signin|sign-in|auth|authenticate|session|account\/login|users\/sign_in)(\/|$)/i;

/** Next.js marks a pass-through from `NextResponse.next()` with this header. */
const PASS_THROUGH_HEADER = 'x-middleware-next';

/** Next.js marks an internal rewrite with this header; a rewrite is not an auth decision. */
const REWRITE_HEADER = 'x-middleware-rewrite';

export interface ResponseLike {
  status: number;
  headers: { get: (name: string) => string | null };
}

/**
 * Does this redirect target look like a sign-in page?
 * Relative and absolute destinations are both accepted; only the path is read.
 */
export function isSignInDestination(location: string | null | undefined): boolean {
  if (!location) return false;
  let pathname = location;
  try {
    // A base is supplied so relative destinations ("/login?next=/admin") parse too.
    pathname = new URL(location, 'https://guard.internal').pathname;
  } catch {
    // Unparseable Location: fall back to the raw value with the query stripped.
    const q = location.indexOf('?');
    pathname = q === -1 ? location : location.slice(0, q);
  }
  return SIGN_IN_PATH.test(pathname);
}

/**
 * Classify a middleware response.
 *
 * `hasUserMiddleware` is required rather than inferred: `withGuard()` with no
 * wrapped middleware always returns `NextResponse.next()`, and reading that as
 * "passed" would mark every route in the application unenforced. When there is
 * no middleware to observe, the honest answer is 'unknown'.
 */
export function classifyOutcome(
  response: ResponseLike | null | undefined,
  options: { hasUserMiddleware: boolean },
): RouteOutcome {
  if (!options.hasUserMiddleware || !response) return 'unknown';

  const status = typeof response.status === 'number' ? response.status : 0;

  // An explicit authentication challenge is unambiguous.
  if (status === 401 || status === 403) return 'blocked';

  if (status >= 300 && status < 400) {
    let location: string | null = null;
    try {
      location = response.headers?.get('location') ?? null;
    } catch {
      location = null;
    }
    // Only a redirect TO a sign-in page is an auth decision. A redirect to a
    // renamed URL, a locale prefix or a trailing-slash fix is not.
    return isSignInDestination(location) ? 'blocked' : 'unknown';
  }

  if (status >= 200 && status < 300) {
    let rewrite: string | null = null;
    try {
      rewrite = response.headers?.get(REWRITE_HEADER) ?? null;
    } catch {
      rewrite = null;
    }
    // A rewrite to a sign-in page renders the login UI under the original URL —
    // the same decision as a redirect, expressed differently.
    if (rewrite && isSignInDestination(rewrite)) return 'blocked';
    return 'passed';
  }

  // 4xx other than 401/403, and every 5xx: the request failed for reasons that
  // say nothing about authentication.
  return 'unknown';
}

/** True when the response is a plain `NextResponse.next()` pass-through. */
export function isPassThrough(response: ResponseLike | null | undefined): boolean {
  if (!response) return false;
  try {
    return response.headers?.get(PASS_THROUGH_HEADER) !== null;
  } catch {
    return false;
  }
}

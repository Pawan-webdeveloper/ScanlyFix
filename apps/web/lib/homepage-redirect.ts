/**
 * The one signed-in routing rule: a visitor with an active session who asks
 * for the landing page is forwarded straight to the dashboard. The homepage's
 * single call to action — paste a URL, start a scan — requires the account
 * they already have, so for them the page is a detour.
 *
 * The escape hatch is `/?home=1`: the console sidebar's logo links there, so
 * "take me home" from inside the app shows the real marketing page instead of
 * bouncing straight back to the dashboard the click came from.
 *
 * This is ROUTING, not authorization. It grants nothing and blocks nothing:
 * /dashboard still defends itself with requireUser(), and a signed-out
 * visitor always sees the landing page.
 */

/** Where a signed-in visit to `/` lands. */
export const SIGNED_IN_HOMEPAGE_TARGET = '/dashboard'

/**
 * Where a request should go when the requester is signed in, or null when the
 * page asked for should render as-is.
 *
 * Kept pure — a boolean and a URL in, a same-site path out — so the routing
 * rule can be tested without standing up a Supabase session. The proxy calls
 * this with `request.nextUrl`, which is a URL.
 */
export function signedInHomepageTarget(userPresent: boolean, url: URL): string | null {
  if (!userPresent) return null
  // Every other path — /pricing, /login, /api/* — renders as asked. The rule
  // is about the homepage only; broadening it here would fork the site's
  // routing across two files.
  if (url.pathname !== '/') return null
  // The console logo's destination. Exactly '1', so /?home=0 still redirects
  // and the escape hatch cannot be smuggled in by a sloppy default.
  if (url.searchParams.get('home') === '1') return null
  return SIGNED_IN_HOMEPAGE_TARGET
}

/**
 * Session refresh on every request.
 *
 * Supabase Auth's access tokens are short-lived; without something rotating
 * them the session dies mid-use and every signed-in page starts failing
 * intermittently. `createServerClient` performs that rotation on a call to
 * `auth.getUser()` and writes the refreshed cookies back through its
 * `setAll` adapter. That is all this file does.
 *
 * It deliberately contains NO authorization. Gating routes here would give the
 * app a second, weaker copy of its access rules — and the copy that lives in
 * the query layer is the one that cannot be bypassed by reaching a page a
 * different way. Pages call requireUser(); queries take a Viewer. This file
 * only keeps the cookie fresh, with ONE routing convenience on top: a
 * signed-in visitor asking for `/` is forwarded to the dashboard
 * (lib/homepage-redirect.ts). That grants and gates nothing — the dashboard's
 * guard is still requireUser(), and the homepage stays reachable at
 * `/?home=1` — it just spares a signed-in user the landing page.
 *
 * Named `proxy` rather than `middleware`: Next 16 deprecated that convention.
 *
 * ## Why there is no stale-cookie surgery here any more
 *
 * This file used to strip auth cookies it judged unreadable, inherited from
 * the Convex era where an unparseable refresh token threw and took the
 * request down. Against Supabase that guard was both unnecessary and wrong.
 *
 * Unnecessary: `@supabase/ssr` already treats a cookie it cannot decode as
 * absent — it catches the base64 and JSON failures itself, warns, and hands
 * back "no session", which is exactly the degradation the guard was written
 * to produce.
 *
 * Wrong twice over, in ways that happened to cancel out. The predicate
 * accepted only a `{...}` JSON body, but the library writes
 * `base64-<base64url>`, so it judged every REAL session cookie unreadable.
 * It was saved only by the name it looked under being wrong too — the ref
 * was parsed as if the Supabase hostname carried an `sb-` prefix, which it
 * does not, so the lookup used a placeholder name that never exists. Fixing
 * either half alone would have deleted every valid session on every request
 * and locked out every signed-in user. Deleting both is the fix.
 */

import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { publicEnv } from '@/lib/public-env.ts'
import { serverEnv } from '@/lib/env.ts'
import { signedInHomepageTarget } from '@/lib/homepage-redirect.ts'

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  warnIfAllowlistMismatched(request)

  // Build a response that will receive any Set-Cookie the client emits when
  // it refreshes the session. createServerClient writes through the
  // getAll/setAll adapter below.
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(publicEnv.supabaseUrl(), publicEnv.supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        supabaseResponse = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options)
        }
      },
    },
  })

  // Touch the session. getUser() refreshes the access token when it is close
  // to expiry and writes the new value back through the adapter above. Do
  // not run any other auth code between createServerClient and getUser().
  // The user it reports also feeds the one routing rule below.
  let userPresent = false
  try {
    const { data } = await supabase.auth.getUser()
    userPresent = data.user != null
  } catch {
    // Transient network errors or Supabase cold-boot timeouts should not crash
    // the proxy. The request continues; downstream auth guards verify the session.
  }

  // A signed-in visitor asking for the landing page goes to the dashboard.
  // The decision lives in lib/homepage-redirect.ts, including the ?home=1
  // escape hatch the console logo uses.
  const homepageTarget = signedInHomepageTarget(userPresent, request.nextUrl)
  if (homepageTarget !== null) {
    const redirectResponse = NextResponse.redirect(new URL(homepageTarget, request.url))
    // getUser() may have rotated the session cookies onto supabaseResponse; a
    // redirect that drops them would force a second rotation on the next
    // request. Carry them over.
    for (const cookie of supabaseResponse.cookies.getAll()) {
      redirectResponse.cookies.set(cookie)
    }
    return redirectResponse
  }

  // event is unused today; reserved for future abort signalling.
  void event

  return supabaseResponse
}

/**
 * One warning per process, not one per request. A boot-time log line is what
 * an operator notices; a per-request log line is what they mute.
 *
 * Every read is inside the try on purpose. `serverEnv.redirectAllowlist`
 * throws on malformed JSON and `serverEnv.appUrl` throws when unset — correct
 * for a caller that needs the value, and unacceptable here, because this
 * runs in the proxy on the way to EVERY page. A typo in an environment
 * variable would otherwise 500 the entire site, including the sign-in page
 * an operator would use to notice. A diagnostic must never be able to take
 * down the thing it is diagnosing.
 */
let allowlistWarned = false
function warnIfAllowlistMismatched(request: NextRequest): void {
  if (allowlistWarned) return
  allowlistWarned = true

  try {
    const allowlist = serverEnv.redirectAllowlist
    if (allowlist.length === 0) {
      console.warn('[auth] SUPABASE_REDIRECT_ALLOWLIST is not set; sign-in may fail.')
      return
    }
    const callback = `${serverEnv.appUrl}/auth/callback`
    if (allowlist.includes(callback)) return

    console.warn(
      `[auth] appUrl ${serverEnv.appUrl} is not in SUPABASE_REDIRECT_ALLOWLIST. ` +
        `Add "${callback}" to the Supabase Auth → URL Configuration redirect allowlist, ` +
        `or every OAuth sign-in will fail with redirect_uri_not_in_whitelist. ` +
        `Saw it from request: ${request.nextUrl.pathname}`,
    )
  } catch (error) {
    console.warn('[auth] could not check the redirect allowlist:', error)
  }
}

export const config = {
  matcher: [
    /**
     * Everything except static assets and the anonymous scan endpoint.
     *
     * /api/scan is excluded deliberately: scanning must keep working logged
     * out, and running a session refresh on it would add a round trip to the
     * identity provider on the one request that is supposed to be fast.
     */
    '/((?!_next/static|_next/image|favicon.ico|api/scan|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}

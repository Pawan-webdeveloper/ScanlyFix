/**
 * Where GitHub sends the user after they install the app.
 *
 * The post-install redirect goes back to the ORIGIN THE BUTTON WAS CLICKED
 * ON, not to NEXT_PUBLIC_APP_URL. Cookies are per-origin: send a
 * localhost:3000 session to the production origin and the callback there
 * sees no session, bounces to /login, and the installation_id GitHub put in
 * the URL is dropped — no row is ever written, so the feed shows Connect
 * GitHub forever, no matter how many times the user signs in.
 *
 * GitHub itself is the real gate against abuse: it only follows a
 * redirect_url that matches one of the app's configured Callback URLs, so a
 * spoofed Host header buys the user a GitHub error page, not a redirect.
 */

/**
 * The origin the current request was served on, for building callback URLs.
 * Falls back to the deployment's own URL when no host header exists (static
 * prerender), so the button degrades to today's behaviour rather than breaking.
 */
export function requestOrigin(headers: Headers, fallback: string): string {
  // Multi-proxy chains append to x-forwarded-host; the first entry is the
  // host the client actually asked for.
  const forwardedHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  const host = forwardedHost || headers.get('host')
  if (!host) return fallback
  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http'
  return `${proto}://${host}`
}

/**
 * The GitHub App install URL, with the post-install redirect back to
 * `origin`. Without an origin, GitHub uses the app's default post-install
 * behaviour — a bare "configure" page — which is still better than a wrong
 * redirect to another deployment.
 */
export function buildInstallUrl(slug: string, origin: string): string {
  const base = `https://github.com/apps/${slug}/installations/new`
  if (!origin) return base
  const callback = `${origin.replace(/\/+$/, '')}/api/github/callback?next=${encodeURIComponent('/feed')}`
  return `${base}?redirect_url=${encodeURIComponent(callback)}`
}

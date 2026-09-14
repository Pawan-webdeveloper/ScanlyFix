# Supabase Auth setup

A one-time list. Once everything here is done, the hero's "Scan now" button
sends a signed-out visitor to `/login`, and after sign-in they land back on
the dashboard with the URL they typed already in the box.

The project is `mxjrcpkfechlylaiaape` (https://supabase.com/dashboard/project/mxjrcpkfechlylaiaape).

> **Rotate before going to production.** An earlier revision of this file
> committed the Google OAuth client secret in plaintext, the GitHub OAuth
> client secret, and the Resend API key. Deleting them from the working copy
> does not remove them from the git history, so all three must be regenerated
> in their respective dashboards. Until that is done, treat every one of them
> as known.

## 1. Environment variables

The Supabase project URL and the publishable (anon) key go in the app's `.env`,
not in any secret store. The service_role key — which bypasses RLS — must
NEVER appear in the app or the browser; it would defeat every authorization
rule the codebase has.

```sh
# apps/web/.env
NEXT_PUBLIC_SUPABASE_URL=https://mxjrcpkfechlylaiaape.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Both are visible in the Supabase dashboard under **Project Settings → API**.
The publishable key is the one labelled "anon / public" (a JWT, starting with
`eyJ`). The publishable key is safe to ship to the browser; the secret one
(starting with `sb_secret_`) is the one that does not.

## 2. Configure the OAuth providers

In the Supabase dashboard: **Authentication → Providers**.

| Provider  | What to enable                | What to do on the provider's side                                                                                                       |
| --------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Google    | Toggle on; paste the OAuth credentials. | In Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 client → Authorized redirect URIs, add the Supabase callback URL displayed beneath the toggle. |
| GitHub    | Toggle on; paste the OAuth credentials. | In GitHub → Settings → Developer settings → OAuth Apps → ScanlyFix → Authorization callback URL, set the URL Supabase shows beneath the toggle. |

The Supabase callback URL is provider-specific and looks like
`https://mxjrcpkfechlylaiaape.supabase.co/auth/v1/callback?provider=google`.
It is **not** the app's own `/auth/callback` — that is where Supabase sends
the browser back to after the provider approves. The two URLs are different
and have to be registered in different places.

## 3. Register the application-side redirect URL

In the Supabase dashboard: **Authentication → URL Configuration**.

### 3a. Set the Site URL (this is the localhost-redirect bug)

The **Site URL** must be the production origin:

| Field    | Value                  |
| -------- | ---------------------- |
| Site URL | `https://scanlyfix.com` |

Supabase projects are provisioned with Site URL = `http://localhost:3000`. When
the `redirectTo` the app sends does not match an entry in the redirect allow
list below, Supabase Auth does NOT error — it **silently falls back to the Site
URL**. With the default still in place that means: press "Continue with Google"
on scanlyfix.com, complete Google's consent screen, and the browser lands on
`http://localhost:3000/auth/callback` — a machine that has no flow in progress.
This is the exact root cause of "Google sign-in redirects to localhost".

### 3b. Add the redirect URLs to the allow list

"Additional Redirect URLs" is matched with glob patterns against the FULL URL,
including any query string. The app's `redirectTo` carries a `?next=…` query
parameter whenever sign-in starts from a deep link (for example the hero form's
`/login?next=/dashboard`), so a bare `/auth/callback` entry will NOT match it.
End each entry with `**`:

| Environment | URL                                        |
| ----------- | ------------------------------------------ |
| Production  | `https://scanlyfix.com/**`                 |
| Production  | `https://www.scanlyfix.com/**`             |
| Development | `http://localhost:3000/**`                 |

Without a matching entry, `signInWithOAuth` succeeds at the provider but the
browser is bounced to the Site URL (see 3a) instead of the app — which is why
the `www` variant is listed too: a visitor on `https://www.scanlyfix.com` sends
a `https://www.scanlyfix.com/auth/callback` redirectTo, and an allow list
holding only the apex domain rejects it.

The `SUPABASE_REDIRECT_ALLOWLIST` variable in the app's `.env` is only a local
mirror of this dashboard list; the proxy logs a boot-time warning when the two
diverge. Changing the env var alone fixes nothing — the dashboard is the
boundary Supabase actually enforces.

## 4. Email-code sign-in (default)

No work needed. Supabase Auth's email provider is on by default and sends a
6-digit code via the project's built-in SMTP. Two settings are worth
checking once:

- **Authentication → Providers → Email** — `Confirm email` should be **off**.
  The product uses Supabase as a one-tap sign-in via code, not as a system
  that requires a separate email-confirmation step. Leaving `Confirm email`
  on means a new account cannot be created through the code flow.
- **Authentication → Email Templates → Magic Link** — the default subject
  mentions a magic link, which is not what the app sends. Either ignore it
  (the app uses `signInWithOtp({ shouldCreateUser: true })` which goes via
  the OTP template, not the magic-link one) or change the subject to match
  the wording the app's sign-in screen promises.

To brand the email, configure a custom SMTP provider (Authentication → SMTP
Settings) and point it at the real `auth.yourdomain.com` sender. Until then,
codes go out from `noreply@supabase.com`, which is the right thing for
development and the wrong thing for production.

## 5. Test it

```sh
cd apps/web
pnpm dev
```

Open http://localhost:3000, paste a URL, click **Scan now**. You should be
redirected to `/login?next=/dashboard`. Sign in with Google, GitHub, or the
email code, and you should land back on `/dashboard` with the URL you typed
already in the box. Press **Scan now** again — the scan will start and route
to `/scan/<id>`.

In Supabase Studio → **Authentication → Users**, confirm the new row appears
with the right `provider`. In the Postgres `users` table, confirm a row
appears with `auth_subject` equal to the Supabase user's UUID.

## 6. What changed when we moved off Convex

The session cookie is now `sb-mxjrcpkfechlylaiaape-auth-token` instead of
`__convexAuthJWT` / `__convexAuthRefreshToken`. The cookie shape is JSON, so
the stale-cookie guard in `proxy.ts` parses the value's first/last byte
rather than splitting on `|` like the old Convex one did. Sign-in flows are
now `signInWithOAuth` + `signInWithOtp` + `verifyOtp` instead of the Convex
Auth library's three callers. Everything below `currentIdentity()` is
unchanged — `getViewer()`, `requireUser()`, the `users.auth_subject` column,
and `ensureUser()` all look exactly the way they did before.
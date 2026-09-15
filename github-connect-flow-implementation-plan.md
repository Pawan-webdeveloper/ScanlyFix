# ScanlyFix: GitHub App Connect Flow — Implementation Steps

This fixes the specific bug: install succeeds on GitHub's side, your app
loses track of who did it, user gets stuck on login with an empty feed. It
also fixes the underlying design gap (relying on session cookies surviving
a third-party redirect) so this class of bug can't recur for other
providers you connect later (Cloudflare, Supabase, etc.).

**[ADAPT]** tags mark stack-specific decisions (framework, DB, secrets
manager). Everything else is close to drop-in logic.

---

## Phase 0 — Fix the GitHub App settings first (5 minutes, do this before any code)

1. Go to your GitHub App settings (not the OAuth App settings — confirm
   you're looking at **GitHub Apps**, not **OAuth Apps**, in the left nav —
   these are different products in GitHub's UI and it's an extremely easy
   tab to confuse).
2. Under **"Identifying and authorizing users"**: **uncheck "Request user
   authorization (OAuth) during installation"** if it's currently checked.
   You don't need GitHub's OAuth identity layer — you already have your own
   login system, and this checkbox is what disables the Setup URL field and
   silently redirects to a Callback URL instead (the exact mismatch that's
   almost certainly your bug).
3. Under **"Post installation"**: set **Setup URL** to one fixed value:
   `https://scanlyfix.com/api/github/setup` **[ADAPT — your actual route]**.
4. Check **"Redirect on update."**
5. Save. Do not touch "Callback URL" — you're not using that flow anymore
   (leave it blank or ignore it; it only matters if OAuth-during-install is
   checked, which it now isn't).
6. **Do not create a second dev GitHub App yet** — get the production flow
   correct first (Phase 1–4), then decide in Phase 9 whether you want a
   second app for local testing.

---

## Phase 1 — Secrets and the state-signing utility

### 1.1 New secret **[ADAPT — wherever you keep GITHUB_APP_PRIVATE_KEY etc.]**

Add `GITHUB_STATE_SECRET` — a fresh random 32-byte value, unrelated to any
other secret in your app (session secret, DB encryption key, etc.). This one
secret's only job is signing/verifying the `state` parameter. Isolating it
means rotating it only affects in-flight connect attempts (worst case, users
mid-flow have to click connect again), not sessions or stored data.

### 1.2 The signing function

```
function signConnectState({ userId }):
  nonce = randomBytes(16).toString("hex")
  issuedAt = now()
  expiresAt = issuedAt + 10 minutes        // short-lived, single-purpose
  payload = { userId, nonce, issuedAt, expiresAt, purpose: "github_connect" }
  signature = HMAC_SHA256(GITHUB_STATE_SECRET, JSON.stringify(payload))
  return base64url(JSON.stringify(payload) + "." + signature)

function verifyConnectState(stateString):
  [payloadJson, signature] = split on last "."
  expectedSignature = HMAC_SHA256(GITHUB_STATE_SECRET, payloadJson)
  if !timingSafeEqual(signature, expectedSignature): reject "bad signature"
  payload = JSON.parse(payloadJson)
  if payload.purpose != "github_connect": reject "wrong purpose"
  if now() > payload.expiresAt: reject "expired, ask user to retry"
  return payload.userId
```

**[ADAPT]**: if your stack already has a JWT library available, a signed
JWT with a 10-minute `exp` claim is the same thing — use whatever your
framework already ships rather than hand-rolling HMAC, the logic above is
just so you know exactly what properties it needs (short expiry, single
purpose, tamper-evident, no server-side storage required — it's entirely
self-contained in the string GitHub round-trips back to you).

Nothing here touches a database. This is the whole point: identity survives
the round trip inside the token itself, not inside a session your cookie
policy might drop.

---

## Phase 2 — Data model

### 2.1 `github_installations` table **[ADAPT — field list, not DDL]**

```
github_installations
  id (uuid, pk)
  installation_id (bigint, unique)       -- GitHub's ID, the stable key
  user_id                                 -- who in YOUR app owns this
  account_login                           -- GitHub org/user name, for display
  account_type                            -- "User" | "Organization"
  status                                  -- "active" | "suspended" | "deleted"
  repository_selection                    -- "all" | "selected"
  created_at
  updated_at
  last_synced_at                          -- last time you confirmed this via API/webhook
```

`installation_id` is unique and is the join key every downstream part of
your app (scan trigger, repo list, feed) should key off — not `user_id`
alone, since one user can eventually have more than one installation
(personal account + an org, for instance).

### 2.2 Why no `pending_installations` table

You don't need one. The `state` token *is* the pending-installation record
— it's just stateless and lives in the URL instead of a table row. Don't
build a table to track "installs in flight," it adds a cleanup problem
(expired pending rows) for something a 10-minute-expiry signed token already
solves for free.

---

## Phase 3 — The connect-initiation endpoint

This is what your "Connect GitHub" button actually points at. **It must be
a route on your own backend, never a hardcoded `github.com/apps/...` link
in your HTML** — you need to run code before redirecting.

```
GET /api/github/connect
  1. require an authenticated session — if none, redirect to /login first,
     with a return-to param that points back to THIS route, so login → connect
     happens in one pass instead of stranding the user mid-flow
  2. state = signConnectState({ userId: session.userId })
  3. redirect (302) to:
     https://github.com/apps/<your-app-slug>/installations/new?state=<state>
```

**[ADAPT — the "your-app-slug"]**: this is the slug from your App's public
page URL, not the App's numeric ID.

Note what changed versus before: the identity check happens **here, on your
own domain, before the user ever leaves it** — not reconstructed after the
fact from whatever survives the trip to GitHub and back. This is the actual
fix, everything else is plumbing to carry that identity through.

---

## Phase 4 — The Setup URL handler (the core of the fix)

```
GET /api/github/setup
  query params from GitHub: installation_id, setup_action, state

  switch setup_action:

    case "install":
      1. userId = verifyConnectState(state)
         -- if this throws (missing/expired/bad signature): render an error
            page: "This connection link expired, please click Connect again"
            with a button back to /api/github/connect. Do NOT silently
            redirect to /login here — that's the exact dead-end you had
            before. Be explicit about what went wrong and how to retry.
      2. Fetch the installation from GitHub's API using your App's own JWT
         (GET /app/installations/{installation_id}) -- do not trust the
         query-string installation_id at face value per GitHub's own
         warning; confirm it actually exists and belongs to your app before
         writing anything.
      3. upsert github_installations:
           installation_id, user_id: userId,
           account_login: response.account.login,
           account_type: response.account.type,
           status: "active",
           repository_selection: response.repository_selection,
           last_synced_at: now()
      4. redirect to /feed?connected=github   -- session already exists
         (user was required to be logged in back in Phase 3), so this is
         a normal same-site navigation, nothing fragile about it

    case "update":
      1. look up existing row by installation_id (should already exist from
         a prior "install" — this event fires when repo access changes on
         an install you already know about)
      2. if found: re-fetch from GitHub API, update repository_selection
         and last_synced_at, redirect to /feed?updated=github
      3. if NOT found (shouldn't normally happen, but don't crash):
         treat it like the "install" case — verify state if present,
         otherwise fall back to requiring login and manual reconnect,
         and log this as a warning to investigate (see Phase 8)

    case "request":
      -- org owner approval required, no installation exists yet
      1. render a page: "Request sent — waiting for an organization owner
         to approve access. We'll notify you once it's approved."
      2. no DB write yet — nothing to write. The eventual approval arrives
         as an `installation` webhook (Phase 5), not a second Setup URL hit.
```

**Everything in the `"install"` branch reads identity from `state`, never
from a session cookie.** This is what makes it survive the cross-site
redirect regardless of your cookie SameSite policy — fix the cookie policy
too (Phase 6) as defense-in-depth, but the correctness of this flow no
longer depends on it.

---

## Phase 5 — Webhook handler (the out-of-band source of truth)

The Setup URL redirect only fires when a user is actively clicking through
your UI. If someone goes directly to `github.com/settings/installations`
and removes a repo, suspends the app, or an org owner approves a pending
"request" from Phase 4 — none of that touches your Setup URL. This is why
you need a webhook regardless of how well Phase 4 works.

### 5.1 Subscribe to these events when configuring the App

- `installation` (created, deleted, suspend, unsuspend)
- `installation_repositories` (added, removed)

### 5.2 Signature verification — do this before parsing the body at all

```
POST /api/github/webhook
  1. read raw request body (not JSON-parsed yet)
  2. signature = header "X-Hub-Signature-256"
  3. expected = "sha256=" + HMAC_SHA256(GITHUB_WEBHOOK_SECRET, rawBody)
  4. if !timingSafeEqual(signature, expected): return 401, stop
  5. NOW parse the body as JSON
```

**[ADAPT]**: `GITHUB_WEBHOOK_SECRET` is a value you set once in the App's
webhook config — different from `GITHUB_STATE_SECRET` from Phase 1, don't
reuse it. Skipping this check means anyone who finds your webhook URL can
send you fabricated "installation deleted" events for accounts they don't
own — verify every time, no exceptions for "trusted" IPs or similar
shortcuts.

### 5.3 Handling logic

```
on "installation" event:
  action = payload.action     -- "created" | "deleted" | "suspend" | "unsuspend"
  installation_id = payload.installation.id

  if action == "created":
    -- this can arrive BEFORE or AFTER your Setup URL redirect completes,
    -- they're not ordered relative to each other. Upsert, don't insert:
    upsert github_installations by installation_id
      -- if user_id is unknown here (webhook has no concept of your app's
      -- users), and no row exists yet, do NOT invent a user_id. Store
      -- account_login + installation_id with user_id = null and a
      -- status of "unclaimed". Phase 4's install branch is what attaches
      -- a real user_id -- this webhook path just makes sure the
      -- installation's existence and repo list are always accurate even
      -- if Phase 4 hasn't run yet or the browser closed mid-redirect.

  if action == "deleted":
    update github_installations set status = "deleted" where installation_id = ...
    -- keep the row, don't hard-delete -- you want scan history to still
    -- reference something, and "reconnect" later should update this same
    -- row rather than create a duplicate

  if action in ("suspend", "unsuspend"):
    update status accordingly -- surface this in your UI: a suspended
    install can't be scanned until unsuspended, tell the user why instead
    of silently failing their next scan attempt

on "installation_repositories" event:
  installation_id = payload.installation.id
  -- payload.repositories_added / repositories_removed arrays
  update your repo-access cache for this installation_id accordingly
  (however you're currently tracking "which repos can this installation
  see" -- keep it in sync here, don't only refresh it lazily on next scan)
```

### 5.4 The "unclaimed" reconciliation

Because Phase 4 (state → user_id) and Phase 5 (webhook, no user concept) can
race or arrive independently, you'll occasionally get a webhook-created row
with `user_id = null` where the Setup URL redirect never completed (browser
closed, network blip). Handle this explicitly rather than leaving orphaned
rows:

- On login, if a user has no `github_installations` row but you can prove
  they were mid-connect (e.g., they still have a valid `state` in a URL
  they return to, or you keep a short-lived "last connect attempt"
  timestamp on their user row), offer a one-click "Finish connecting
  GitHub" that re-fetches installations via the GitHub API for their known
  GitHub identity and lets them claim an unclaimed row. This is a small
  UI affordance, not a big feature — it exists purely to close the race
  window between Phase 4 and Phase 5 instead of leaving a silent orphan.

---

## Phase 6 — Session/cookie hardening (defense-in-depth, not the primary fix)

Do this regardless — it's cheap and it's good practice even though Phase 4
no longer depends on it working:

- Session cookie: `SameSite=Lax`, `Secure`, `HttpOnly`.
- `Domain` attribute set consistently (e.g. `.scanlyfix.com` covering both
  apex and `www`) so a stray redirect landing on the "other" host of the
  two doesn't look logged-out for an unrelated reason.
- **[ADAPT]** if you're on a framework with its own session/auth library
  (NextAuth, Clerk, Lucia, etc.), check its default `SameSite` setting
  specifically — several default to `Lax` already, some ship `Strict` for
  certain cookie types (CSRF tokens especially) by default, which is a
  different cookie than the session itself but can still break a
  cross-site-redirect-dependent CSRF check if you're not careful. Audit
  every cookie your auth stack sets, not just the session one.

---

## Phase 7 — Feed page

Update whatever powers your feed/dashboard to query
`github_installations where user_id = session.userId and status = 'active'`
(joined however your scan history already links to installations) instead
of however it currently determines "does this user have GitHub connected."
This is likely a one-line change once Phase 2–4 are in place, but it's the
step that actually makes the fix visible to users — everything before this
is invisible plumbing until the feed reads from the right place.

---

## Phase 8 — Reconciling users who already got stuck

Because this bug has presumably already been live, some real users clicked
connect, approved on GitHub, and landed on a dead end before you read this.
Their installation exists on GitHub's side with no matching row in your DB.

1. Call `GET /app/installations` (paginated) with your App's JWT — this
   lists every installation of your App across all accounts, regardless of
   whether your Setup URL flow ever completed for them.
2. For each `installation_id` not already in your `github_installations`
   table, insert it with `user_id = null`, `status = "unclaimed"` — same
   shape as the webhook race case in Phase 5.4.
3. **[ADAPT]** — you can't automatically know which of your app's users
   each unclaimed installation belongs to (GitHub's installation object
   tells you the *GitHub* account, not your app's internal user_id). Match
   by whatever identifying info you have (if you store GitHub usernames or
   emails anywhere from your existing partial signup data) and/or email
   affected users: "We noticed your GitHub connection didn't complete —
   click here to finish" pointing at the Phase 5.4 claim flow.

---

## Phase 9 — Local development

Now that Phase 0–7 make the production flow correct, decide how to test
locally:

- **Simplest**: use a tunnel (ngrok, Cloudflare Tunnel) pointed at your
  local dev server, and temporarily point the same GitHub App's Setup URL
  at the tunnel URL while developing this specific feature, switching back
  before merging. Fine for solo work, annoying if more than one person
  needs to test connect-flow changes at once.
- **Better if more than one person will touch this**: register a second,
  separate GitHub App (e.g. "ScanlyFix Dev") with its own slug, client
  credentials, and Setup URL pointed at `http://localhost:3000/api/github/setup`
  (or your tunnel), gated behind an env var
  (`GITHUB_APP_SLUG`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` switched
  per environment). This is the standard pattern and worth doing once you're
  past the immediate bugfix — but don't let it block shipping Phase 0–8
  first.

---

## Phase 10 — Test matrix before calling this done

Run through every one of these manually at least once; most of them are the
exact edge cases that caused the original bug:

| Scenario | Expected result |
|---|---|
| Logged-in user, fresh install, approves all repos | Row created, `user_id` set correctly, lands on `/feed?connected=github` with data visible immediately |
| Logged-in user, fresh install, approves selected repos only | `repository_selection = "selected"`, correct repo list available on feed |
| User clicks Connect while logged **out** | Redirected to login first, then straight into the connect flow after — never silently drops the intent |
| `state` expires (wait >10 min between click and approving on GitHub) | Clear "link expired, click Connect again" message, not a silent redirect to login |
| User approves, then closes browser before Setup URL redirect finishes loading | Phase 5 webhook still creates an "unclaimed" row; user can claim it via Phase 5.4/8 flow on next login |
| Org owner needs to approve (`setup_action=request`) | User sees a clear "pending approval" state; once approved, the `installation` webhook (not a second Setup URL hit) creates the row |
| User removes a repo from the installation directly on GitHub's settings page (not via your app) | `installation_repositories` webhook updates your repo cache without the user ever hitting your Setup URL |
| User suspends the app on GitHub | `installation` webhook sets `status = "suspended"`; next scan attempt shows a clear "reconnect" message instead of a confusing failure |
| Webhook arrives with a tampered/missing signature | Rejected with 401, never reaches your JSON parsing or DB logic |
| Two browser tabs both mid-connect for the same user | Each has its own valid `state`; whichever completes first creates the row, the second is just a redundant upsert — confirm this doesn't throw on the unique `installation_id` constraint (it shouldn't, since one user only gets one `installation_id` per real GitHub install action) |

---

## Suggested order to actually ship this

1. **Phase 0 + Phase 1** — settings change and the signing utility. No user-
   facing change yet, nothing to break.
2. **Phase 2 + Phase 3 + Phase 4 (`install` case only)** — this is the
   minimum that fixes your reported bug. Ship and verify against the first
   three rows of the Phase 10 test matrix before moving on.
3. **Phase 4 (`update`/`request` cases) + Phase 5 (webhook)** — closes the
   out-of-band gaps; do this before real traffic scales, not after.
4. **Phase 6 + Phase 7** — cheap, do alongside step 3.
5. **Phase 8** — run once, after step 2 is confirmed working, to sweep up
   anyone already stuck.
6. **Phase 9** — whenever local-dev friction actually starts costing you
   time; not urgent relative to 1–5.

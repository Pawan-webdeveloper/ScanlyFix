# ScanlyFix: OAuth ↔ MCP Split — Integration Plan (FixVibe build)

**Source material:** every code pattern below was read directly out of `usestrix/strix`
— `strix/tools/mcp/config.py`, `loader.py`, `registry.py`, `session.py`, `client.py`,
`failures.py`; `strix/interface/cloud/http.py`, `spec.py`; `docs/integrations/mcp.mdx` —
and re-verified against the live repo before this rewrite. Nothing here is invented from
general MCP knowledge.

**What changed in this revision:** the plan is no longer stack-agnostic. Every `[ADAPT]`
placeholder has been resolved against *this* repository — the actual `apps/web` App Router
tree, the `packages/db` Drizzle schema, the existing `connections`/vault tables, the Inngest
function layout, and the console component conventions. The two product surfaces called out
by the owner are now first-class sections: **all connection apps render on the Feed page**
(§3.2) and the **dashboard's bottom section shows Connect GitHub → Supabase → the rest, in
that order** (§3.3).

Companion doc: `deep-scan-integrations-implementation.md` (the tier/ownership rationale and
§11 "what not to copy from Strix"). This plan builds on it and never contradicts it: where
that doc scopes Level 1 (publishable key) and Level 2 (scoped Postgres role), this plan's
MCP tier slots in above them without redefining them.

---

## 0. The one-sentence architecture

> **OAuth owns trust. MCP owns interface. A short-lived bridge converts one into the other
> per scan/fix-run, and is torn down when the run ends.**

Two persistent things exist in the database. Nothing else is persistent:

1. **Connected grants** — one row per provider connection the user made (Supabase project
   today; GitLab, Cloudflare next). Secrets live encrypted in the vault. Rows persist until
   the user disconnects.
2. **Nothing MCP-related is persisted.** An MCP connection is **built fresh, in memory, for
   the lifetime of one scan or one fix-run**, from the stored grant, and discarded when the
   run ends. This is exactly what Strix does — `McpRegistry` is built per-run and cleared
   when the run finishes (`registry.py`: *"One `McpRegistry` is built per run... stored in
   the run context"*). There is no long-lived MCP client object holding a token in a global.

This matters more than it sounds: a leaked in-memory object, a stuck worker, a crashed
Inngest function — none of them leak a live authenticated session past the job that used it.

### 0.1 What this repo already has vs what is missing

Verified against the tree on 2026-09-14:

| Plan concept | FixVibe status | Where |
|---|---|---|
| `integrations` table | **Exists** as `connections` (provider enum `['supabase']` today) | `packages/db/src/schema.ts:1119-1175` |
| Envelope-encrypted secret store | **Exists** — `connection_secrets` (per-record DEK + root key) | `packages/db/src/schema.ts:1185-1197` |
| Decrypt audit trail | **Exists** — `credential_access_log`, every decrypt logged with purpose | `packages/db/src/schema.ts:1205-1215` |
| Seal/open helpers | **Exists** — `sealSecret` / vault in `apps/web/lib/credentials-vault.ts` | `apps/web/lib/credentials-vault.ts` |
| Non-secret redaction helper | **Exists** | `apps/web/lib/redact.ts` |
| Host-allowlist validator (the `_SUPABASE_STORAGE_HOST` pattern) | **Exists** — `parseProjectUrl` refuses anything not `*.supabase.co` | `apps/web/lib/supabase-connect.ts` |
| GitHub connect | **Exists** — GitHub **App** install flow: `buildInstallUrl` → `/api/github/callback` → `github_installations` table; per-use tokens via `mintInstallationToken(installationId)` | `apps/web/lib/github-connect.ts`, `apps/web/lib/github-app.ts`, `packages/db/src/queries/github-installations.ts` |
| Connect/list/revoke/scan API | **Exists** for Supabase Level 1 | `apps/web/app/api/connections/route.ts`, `.../[id]/route.ts`, `.../[id]/scan/route.ts` |
| Connection UI (feed) | **Exists** for Supabase; GitHub CTA exists | `apps/web/app/(app)/feed/page.tsx`, `apps/web/components/console/supabase-connections.tsx` |
| Unified connection-apps UI on feed **and** dashboard bottom | **Missing — build (§3)** | new `apps/web/components/console/connect-apps.tsx` |
| GitLab / Cloudflare connect | **Missing — build (§1.3)** | route extensions + validators |
| MCP **client** (consuming side): config / registry / http client / bridge | **Missing — build (§2)** | new `packages/mcp-client` |
| MCP **server** (exposing side) | **Exists, and stays untouched** — ScanlyFix-as-MCP-server over stdio | `packages/mcp-server` |

The last row matters for orientation: `packages/mcp-server` already lets *Claude drive
ScanlyFix*. This plan builds the *opposite arrow* — ScanlyFix reaching *out* through MCP to
the providers the user connected. Same protocol, opposite direction, separate package.

---

## 1. Layer 1 — Connections (the trust layer)

### 1.1 Data model: extend `connections`, never add a parallel `integrations` table

The generic plan's `integrations` table and this repo's `connections` table are the same
concept. Adding a second table would fork the trust model (two vaults, two audit paths, two
revocation flows) — so the build is:

1. **Widen the provider enum** (`packages/db/src/schema.ts:1119`):

   ```ts
   export const connectionProviderEnum = pgEnum('connection_provider', [
     'supabase', 'gitlab', 'cloudflare',
   ])
   ```

   **GitHub is deliberately NOT in this enum and must never be added.** GitHub's grant is
   already stored — as a `github_installations` row — and it is *better* than a stored
   token: the GitHub App mint is a short-lived installation token (`mintInstallationToken`
   in `apps/web/lib/github-app.ts`) created at the moment of use and expiring on its own.
   That is the per-run credential model of §0 already achieved, for free, on day one.
   Storing a second, long-lived GitHub token in `connections` would be strictly worse than
   what exists.

2. **Add the columns the OAuth/PAT providers need** (one Drizzle migration via
   `pnpm db:deploy`, new file in `packages/db/drizzle/`):

   ```ts
   authKind:        connectionAuthKindEnum('auth_kind').notNull().default('api_key'),
   //                'api_key' (today's Supabase paste) | 'pat' | 'oauth'
   tokenExpiresAt:  timestamp('token_expires_at', { withTimezone: true }),
   lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
   ```

   and extend `connectionStatusEnum` from `['active','revoked','error']` with **`'expired'`**
   (the state the circuit breaker in §2.7 sets after repeated auth failures, so the UI can
   say "re-connect" instead of generic "error").

   **Refresh tokens and multi-secret credentials are not columns.** A GitLab/Cloudflare
   OAuth grant has an access token *and* a refresh token — both are secrets. They are
   sealed together as one JSON envelope (`{ accessToken, refreshToken }`) into the existing
   `connection_secrets.ciphertext` by `sealSecret`. The vault stays the only secret store;
   no secret ever gains a plaintext column.

3. **`projectUrl` becomes the origin-binding column.** For Supabase it already holds
   `https://<ref>.supabase.co` — the exact origin the key may ever be sent to. For GitLab
   it holds the instance origin (`https://gitlab.com` or the self-hosted URL); for
   Cloudflare it holds `https://api.cloudflare.com`. This column is this repo's
   `issuer_origin` — the field that makes Strix's `_validate_stored_token_origin` check
   possible (§1.4). Document the broadened meaning in the schema comment; do not rename the
   column (every query path already reads it, and a rename buys nothing).

4. **RLS note.** All access flows through the server-side Drizzle client with a `Viewer`
   (`packages/db/src/queries/connections.ts` takes a `Viewer` on every function — a forged
   id resolves to null). No `connections` row is ever reachable from a client-side Supabase
   query, so the access rule is enforced in code where it is testable; keep it that way.

### 1.2 Endpoints: the generic plan's set, mapped onto the actual App Router tree

The Next.js tree already has `app/api/connections/[id]/...`. Two dynamic segments with
*different* names at the same level (`[id]` vs `[provider]`) are a Next.js build error, and
static segments are legal siblings of a dynamic one. So the provider-scoped routes nest
under **static** parents, and the tree stays legal:

| Generic plan endpoint | FixVibe route | File | Status |
|---|---|---|---|
| `GET /api/integrations` | `GET /api/connections` | `apps/web/app/api/connections/route.ts` | **exists** |
| `POST /api/integrations/:provider/connect` (PAT-paste) | `POST /api/connections` with `{ provider, ... }` | `apps/web/app/api/connections/route.ts` | **exists for supabase; extend for gitlab/cloudflare** |
| `POST /api/integrations/:provider/install-url` | `POST /api/connections/install-url/[provider]` | `apps/web/app/api/connections/install-url/[provider]/route.ts` | **new** |
| `GET /api/integrations/:provider/callback` | `GET /api/connections/callback/[provider]` | `apps/web/app/api/connections/callback/[provider]/route.ts` | **new** (GitLab/Cloudflare OAuth redirect target) |
| `POST /api/integrations/:provider/validate` | `POST /api/connections/validate/[provider]` | `apps/web/app/api/connections/validate/[provider]/route.ts` | **new** (re-check button; the *initial* connect validates inline, exactly as the Supabase route already does: parse → validate → probe → seal) |
| `DELETE /api/integrations/:provider` | `DELETE /api/connections/[id]` | `apps/web/app/api/connections/[id]/route.ts` | **exists** |
| — (GitHub App install) | `GET /api/github/callback` | `apps/web/app/api/github/callback/route.ts` | **exists** — GitHub needs none of the new routes |

Every new route follows the house pattern already visible in `api/connections/route.ts`:
`export const runtime = 'nodejs'`, `getViewer()` guard returning 401 for non-users, `fail()`
helper with explicit status codes, a 503 with a clear message when
`serverEnv.connectionsConfigured` is false, and a response body that **never** contains a
token, a masked token, or a vault pointer.

### 1.3 Per-provider connect flows (what actually gets built)

**GitHub — already built; UI-only work left.** Install flow via the ScanlyFix GitHub App
(`buildInstallUrl` → post-install redirect → `/api/github/callback` → `github_installations`).
The origin-echo bug this repo already solved in `github-connect.ts` (callback returns to the
origin the button was clicked on, because cookies are per-origin) is precisely Strix's
`_bind_login_record(record, app_url)` lesson, already applied. Nothing to add in Layer 1.

**Supabase — keep Level 1 exactly as is.** The publishable-key flow
(`parseProjectUrl` + `validateAnonKey` + `probeProject` + `sealSecret`) is the trust model
the product advertises. A Management-API PAT tier would be a *new* grant kind, and the
scoped-Postgres-role flow stays the Level-2 path per the deep-scan plan — MCP does not
change that ordering (§2.6).

**GitLab — PAT-paste first, OAuth second.** Mirroring Strix's split (`spec.py:857-892`:
GitLab/Bitbucket get `connect` + `validate` with a raw token; GitHub/Slack get the
install-URL flow, because not every provider makes app-install easy):

- `POST /api/connections` body: `{ provider: 'gitlab', instanceUrl?, token }`.
- Validator lives in a new dependency-free module `apps/web/lib/gitlab-connect.ts` (same
  shape as `supabase-connect.ts`: pure functions, unit-testable, no env imports — the
  routes own auth and sealing):
  - default origin `https://gitlab.com`; a self-hosted `instanceUrl` is allowed **only**
    after the SSRF-safe origin check below (§1.4) — https-only, no credentials-in-URL, no
    non-ASCII hosts, no loopback/metadata addresses;
  - validate the token with `GET {origin}/api/v4/user` (401 → refuse with copy naming the
    fix, same tone as `validateAnonKey` refusing a service-role key by name);
  - `externalAccount` = the returned username, `scopes` = requested scopes
    (`read_api`), `projectUrl` = the validated origin.

**Cloudflare — API-token paste.** New `apps/web/lib/cloudflare-connect.ts`:

- validate with `POST https://api.cloudflare.com/client/v4/user/tokens/verify`
  (`Authorization: Bearer <token>`), which returns the token's status — refuse `disabled`/
  `expired` by name;
- request the account list (`/client/v4/accounts`) so the user picks which account the
  grant is for; `externalAccount` = that account id, `projectUrl` =
  `https://api.cloudflare.com` (fixed — Cloudflare has no self-hosted variant);
- scopes recorded as the permission groups the product needs (e.g. `zone.read`,
  `dns_records.read` for the first read-only checks).

### 1.4 Non-negotiable security behaviors — each mapped to the code that already does it

| Pattern (Strix origin) | FixVibe equivalent — existing or to build |
|---|---|
| Never log or serialize the token (`session.py` docstring: held in memory only, *never logged, serialized into the run's event stream, or written to disk*) | `apps/web/lib/redact.ts` on every log line; vault returns sealed material only; `getSecretForConnection` (the ONE decrypt path) logs to `credential_access_log` on every open. Extend both: the `connections` JSON response and the mcp-client §2.1 must be covered by a redaction test (stringify an entry, assert the token never appears). |
| Non-secret status projection (`McpConnectionStatus`: *"No config, token, url, or purpose rides here"*) | `GET /api/connections` already returns rows without secrets; §3's UI cards consume the same projection (`provider`, `status`, `connectedAt`, `scopes`, `externalAccount`) — never the token. |
| SSRF-safe URL validation before any outbound call (`cloud/http.py _parse_origin_url`) | **Template already in the repo:** `parseProjectUrl` in `apps/web/lib/supabase-connect.ts` (https-only, `*.supabase.co` allowlist, ref extraction). Generalize it into `apps/web/lib/origin.ts` — `validateOutboundOrigin(input, { allowHosts })` — and have `gitlab-connect.ts` / `cloudflare-connect.ts` / every future provider use that one function. One shared validator, not one per call site — the exact funneling Strix does with the single `request()` in `http.py`. |
| Bind URLs to a known-good host pattern (`_SUPABASE_STORAGE_HOST`) | The `allowHosts` argument of `validateOutboundOrigin`; for Supabase it stays `*.supabase.co`, for Cloudflare `api.cloudflare.com`, for GitLab `gitlab.com` + explicitly verified self-hosted origins. |
| Origin binding, re-checked before every use (`_validate_stored_token_origin`) | Before any outbound call with a stored credential (MCP bridge included): `assert tokenOrigin === new URL(endpoint).origin`, hard-fail into connection status `'error'` otherwise. Implemented once in the bridge (§2.4), not at each call site. |
| Gate write capability behind proven ownership | Already the product's own promise (`domain-verification.ts`). Extended per §2.6: a fix-run that may *write* (create branch/PR) requires the target repo to belong to a verified installation **and** the fix tier's entitlement check — OAuth-connect alone never unlocks writes. |
| Configure-gate (fail closed when unconfigured) | `serverEnv.connectionsConfigured` 503 pattern — every new route repeats it verbatim; the mcp-client is simply inert (empty registry) when no grants exist, matching `loader.py`'s *"without it, a run simply gets no MCP tools"*. |

---

## 2. Layer 2 — the MCP client (the interface layer)

### 2.1 New package `packages/mcp-client` — protocol spoken directly, no SDK

House rule, stated in `packages/mcp-server/src/index.ts` itself: this repo speaks external
protocols with `fetch` rather than taking a vendor client ("what it costs is the ~120
lines; what it buys is that the wire format is readable in one file instead of being a
version range in a lockfile"). The consuming side follows the same rule, and the surface is
the same stable core the mcp-server package already speaks — `initialize`, `tools/list`,
`tools/call`, `ping` — over **streamable HTTP** only.

```
packages/mcp-client/
  package.json          name @scanlyfix/mcp-client, type module, vitest — mirrors mcp-server's
  src/
    config.ts           McpConnectionConfig (zod) — port of strix config.py
    registry.ts         per-run registry — port of strix registry.py
    client.ts           streamable-HTTP connect / list / call — port of strix client.py
    failures.ts         classify + backoff + quarantine — port of strix failures.py/session.py
    bridge.ts           stored grant → live connection (attachMcpRequests) — §2.4
    index.ts            public surface only (db package style: no deep imports)
  test/
    config.test.ts  registry.test.ts  client.test.ts  failures.test.ts  bridge.test.ts
```

**`config.ts` — port of `config.py` (verified field-for-field):**

```ts
export const DEFAULT_MAX_CONCURRENT_CALLS = 4

export const BearerAuth = z.object({
  kind: z.literal('bearer'),
  token: z.string().min(1),
})
export type BearerAuth = z.infer<typeof BearerAuth>

export const McpConnectionConfig = z.object({
  name: z.string().min(1),                 // unique per run; namespaces the tools
  url: z.string().min(1),                  // http transport is the ONLY transport — see below
  auth: BearerAuth.nullable().default(null),
  allowedTools: z.array(z.string()).nullable().default(null),
  notes: z.string().nullable().default(null),
  httpTimeoutSeconds: z.number().positive().default(30),   // strix: the SDK's 5 s default is below tool p95s
  sessionTimeoutSeconds: z.number().positive().default(60),// strix: SQL/cloud describe fan-outs
  maxConcurrentCalls: z.number().int().min(1).default(DEFAULT_MAX_CONCURRENT_CALLS),
})
```

Two details deliberately carried over:

- **`allowedTools` is enforced at the protocol boundary, not app-side.** In `client.py`,
  `create_static_tool_filter(allowed_tool_names=config.allowed_tools)` is passed *into the
  server object itself, so a disallowed tool never even appears in `list_tools()`*. The
  port does the same: `tools/list` results are filtered inside `client.ts` before anything
  upstream can see them — the agent cannot discover a write tool it was never granted, let
  alone call it. This is the mechanism that makes "scan tier" and "fix tier" two different
  permission sets on the *same* stored grant (§2.6).
- **Secret-safe representation.** `config.py` marks the token `repr=False`. The TS
  equivalent: `BearerAuth` gets a custom `toJSON`/`toString` that renders
  `"[bearer token redacted]"`, plus a redaction unit test (`JSON.stringify(config)` never
  contains the token) — same discipline as `redact.ts`.

**No `stdio` transport, on purpose.** Strix supports it because it's a CLI spawning
subprocesses on the user's machine. ScanlyFix's runs execute on our infrastructure; the
consuming client speaks http against remote MCP endpoints only. The schema simply has no
`transport`/`command`/`args`/`env` fields — a smaller contract than Strix's is a feature
here. (The stdio code in `packages/mcp-server` is the *exposing* side and is unaffected.)

**`registry.ts` — port of `registry.py` (verified):** a `Map<name, McpConnectionEntry>`
with `add() / get() / names() / summaries() / statuses() / clear()`, plus the frozen types:

- `McpConnectionEntry` — `{ session, name, purpose, toolCount, provider, resultTransform }`;
  the docstring discipline carries over: the entry *carries* the live credential-bearing
  session and is never logged or serialized.
- `McpConnectionSummary` — `{ name, purpose, toolCount, provider }` — what a future
  `list_mcps` tool returns; *no tool schemas*.
- `McpConnectionStatus` — `{ name, provider, toolCount, dead }` — *"non-secret by
  construction"*; this is the exact shape the UI/API may render (§3).
- `McpConnectionRequest` — the inert attach request: `{ config, provider, resultTransform,
  purpose }`. The caller hands the engine an inert config and **never a live session** —
  this is the OAuth→MCP bridge object.

**`client.ts` — port of `client.py` (verified):** JSON-RPC over streamable HTTP with
`fetch` — `initialize` (protocol-version negotiation; the mcp-server package already
negotiates the same revisions), `tools/list` with the static `allowedTools` filter applied
at listing time, `tools/call`, bounded by `maxConcurrentCalls` via a simple promise-count
semaphore per connection. `dispatchMcpCall(connection, tool, args)` is the single dispatch
path, and it applies `resultTransform` on **every** result before it reaches anything
upstream — the strix-pro sanitizer hook (§2.5).

**`failures.ts` — port of the `session.py`/`failures.py` state machine (verified):**

- connect failure → that connection is **skipped for the run** (fail-open — `loader.py`/
  `client.py`: *"a connection whose initial connect fails is skipped rather than raised"*),
  never fatal to the job;
- call failures classified: `permission` (provider said no to this request — connection
  stays usable), `protocol` (malformed — stays usable), `transient` (retried:
  `min(8, 0.5 * 2**(attempt-1))` seconds + jitter, max 3 attempts — the verified
  `_retry_delay` constants), and auth (401/403) which **quarantines** the connection for
  the run;
- repeated auth failures across runs → `upsertConnection`-adjacent helper flips the row's
  `status` to `'expired'` (§1.1) so the UI prompts re-connect instead of hammering a
  revoked token;
- **build this before the second provider**, not after — retrofitting retry/quarantine
  across multiple integrations at once is far more error-prone than building it once
  against one provider and reusing it.

### 2.2 Generic dispatch, not per-provider tools — and the honest note about the current agent

Strix's design win (`registry.py` docstring, verified): the old model put *every tool of
every server* on the root agent's first LLM request; the fix is three generic dispatch
tools — `list_mcps`, `describe_mcp(connection)`, `call_mcp(connection, tool, args)` — so a
run with N connections costs **zero** extra prompt tokens regardless of how many tools each
exposes. The agent discovers capabilities at call time via `describe_mcp`.

**This repo does not yet have an agent loop.** `apps/web/lib/fixes.ts` is a one-shot Gemini
call that returns fix text; there is no tool-calling harness to register `list_mcps` in.
The plan is therefore staged, honestly:

- **Phase A (now):** the fix/scan path uses `packages/mcp-client` *directly* — the Inngest
  function opens the registry, issues the specific read calls the prompt needs
  (e.g. `call_mcp('github', 'get_file_contents', …)` for the file a finding points at),
  closes the registry, and hands the gathered context to `lib/fixes.ts` as before. No
  agent loop, no dispatch tools, full security machinery.
- **Phase B (when the fix tier becomes agentic):** the three dispatch tools are registered
  in whatever harness exists by then, backed by the same registry. Because the registry
  never assumed a particular harness, Phase B is additive — nothing in §2.1 changes.

### 2.3 Where the registry lives: one per Inngest function run

The Inngest functions in `apps/web/inngest/functions/` are the job runner (`run-repo-scan.ts`,
`run-scan.ts`, `generate-report.ts`). The rule from Strix's runner, adapted:

- build one `McpRegistry` at the top of the function's handler;
- thread it through the function's existing context (the same way the scan/worker context
  already flows);
- close **every** session in a `finally` — mirroring `client.py`'s guarantee that *"every
  session started so far is closed ... before the cancellation is re-raised"*, which in
  Inngest terms means an early throw, a step failure, or a cancellation all still tear down;
- **never** a module-level singleton — a global registry means job A's Supabase grant is
  reachable from job B, which is the one mistake this architecture exists to make
  impossible.

### 2.4 The bridge: stored grant → live connection (`bridge.ts`)

Port of `attach_mcp_requests()` in `client.py` (lines 341–374, verified), at the top of
every run that needs integrations:

```
1. fn starts with { userId, providers: ['github'] | ['github','supabase'] | ... }
2. for each provider:
     github      → row = the account's github_installations entry
                   token = mintInstallationToken(installationId)      // short-lived by design
                   origin = https://api.githubcopilot.com             // fixed
     gitlab      → row = connections(userId, 'gitlab')
                   { accessToken } = unsealSecret(getSecretForConnection(id, viewer, 'mcp-bridge'))
                   origin = row.projectUrl                             // the binding column from §1.1
     supabase/cloudflare → same vault path as gitlab
     assert status === 'active' (an 'expired'/'error' row is skipped and reported, not fatal)
     assert origin === new URL(PROVIDER_MCP_ENDPOINTS[provider]).origin   // §1.4 origin binding
3. configs = rows.map(row => new McpConnectionConfig({
     name: provider,
     url: PROVIDER_MCP_ENDPOINTS[provider],      // fixed per provider — NEVER user-supplied
     auth: { kind: 'bearer', token },
     allowedTools: TOOL_TIER[jobKind][provider], // §2.6 — scan tier vs fix tier
     notes: `${provider} grant for this account, connected ${row.createdAt}`,
   }))
4. registry = new McpRegistry()
5. attachMcpRequests(configs, registry)          // fail-open per connection; partial success is fine
6. run the job with the registry in its context
7. finally: close every session; registry.clear(); drop the reference
```

The single most important line is step 3's comment: **the endpoint URL is fixed per
provider, never user-supplied**. The only user-influenced value in a config is the
self-hosted GitLab instance URL, and that never becomes an MCP endpoint — it is the token's
validation origin only. This is the exact rule that stops a misconfigured connection from
turning into "send our stored token to an attacker's host."

**`PROVIDER_MCP_ENDPOINTS` — one constant map, with verification status:**

| provider | endpoint | status |
|---|---|---|
| `github` | `https://api.githubcopilot.com/mcp/` | **verified** — it is the exact remote server in Strix's own docs example (`docs/integrations/mcp.mdx`), and it accepts a GitHub App installation token as the bearer credential |
| `supabase` | Supabase's hosted MCP endpoint | **verify at build time** — confirm the current URL and its auth model (Management-API PAT) before wiring; until then Supabase stays on the direct-HTTP Level-1 engine, which already works and needs no MCP |
| `gitlab` | GitLab's hosted MCP endpoint | **verify at build time** — same rule; until verified, GitLab-connected context gathering uses the plain REST API through `gitlab-connect.ts` |
| `cloudflare` | Cloudflare ships per-product MCP servers, not one | **verify at build time** — if no single endpoint covers the needed reads, build a ~100-line internal HTTP-MCP shim (same shape as `packages/mcp-server`, opposite direction) rather than letting the config point at a partial server |

One map, one place to correct, and the bridge refuses to start a connection whose endpoint
is unverified.

### 2.5 `resultTransform` — the sanitizer hook, from day one

`dispatch_mcp_call` in `client.py` runs a transform on **every** tool result before it
reaches the agent or gets logged ("strix-pro's sanitizer" — verified). Wire the TS
equivalent per-connection at config-build time:

1. **redact** via `apps/web/lib/redact.ts` — a provider response can carry secrets that
   are not ours to hold (a collaborator's email in a GitHub payload, a connection string in
   a describe-schema result);
2. **truncate** — Strix deliberately keeps multi-kilobyte JSON out of what reaches the
   model; same cap here: after N KB, keep structure + first error, drop bulk.

Because §2.2 Phase A hands results straight into `lib/fixes.ts`, the transform protects the
prompt and the stored report, not just a future agent loop.

### 2.6 Two job kinds, same grants, different `allowedTools` — and the ownership gate

```
SCAN run (read-only — the product's current safety promise)
  github     -> ['get_repo', 'list_files', 'get_file_contents', 'list_issues', 'search_code']
  gitlab     -> read-only project/file reads
  cloudflare -> zone/dns read-only list
  supabase   -> stays on the Level-1 direct engine; MCP tier deferred (§2.4 note)

FIX run (writes — shipped last, behind the existing ownership gate)
  requires: repo owned by a verified installation + fix-tier entitlement (lib/entitlements.ts)
  github     -> [...scan tier..., 'create_branch', 'create_or_update_file', 'create_pull_request']
  everything else -> unchanged read-only; "we scan it but never touch it" is enforced
                      by the allowlist being the only gate, exactly as Strix does it
```

The run never chooses its tier — the tier is decided by which `McpConnectionConfig` the
bridge builds (§2.4 step 3), before any model call exists. A "create PR" action therefore
requires: verified ownership (domain-verification gate, extended to repos) + entitlement +
allowlisted tool — the same "capability, not config-outside-a-gate" rule the deep-scan
plan already applies to Supabase RLS checks.

The PR-creation sequence itself mirrors what the current fix-prompt output *suggests* in
markdown today: `create_branch` → `create_or_update_file` → `create_pull_request` — the
same steps the user currently pastes into Cursor, executed through allowlisted MCP calls.

---

## 3. UI wiring — Feed page and Dashboard (the owner's explicit asks)

### 3.1 One source of truth for the provider list and its order

New file `apps/web/lib/connection-providers.ts` (client-safe: no `server-only`, no env —
same discipline as `supabase-connect.ts`):

```ts
export interface ProviderApp {
  provider: 'github' | 'supabase' | 'gitlab' | 'cloudflare'
  label: string            // "GitHub"
  blurb: string            // one sentence under the label
  connectKind: 'github-app' | 'paste' | 'oauth'
  dashboardCta: string     // "Connect GitHub" | "Connect Supabase" | ...
}

/** Render order everywhere: GitHub first, Supabase second, then the rest. */
export const PROVIDER_APPS: readonly ProviderApp[] = [
  { provider: 'github',     ... },
  { provider: 'supabase',   ... },
  { provider: 'gitlab',     ... },
  { provider: 'cloudflare', ... },
]
```

Feed and dashboard both render from this array, so the order can never drift between the
two pages.

### 3.2 Feed page — all connection apps, one hub

`apps/web/app/(app)/feed/page.tsx` currently renders: error banner → GitHub CTA →
**Repositories** → **Supabase projects** → *Connected accounts* (multi-install list). The
change inserts a **"Connect your apps" hub** (`id="connect"`) directly under the error
banner, and keeps every existing section below it:

1. **Hub section** — a 2×2 grid of provider cards rendered from `PROVIDER_APPS`. Each card
   shows: provider mark (extend `apps/web/components/console/icons.tsx` with
   `github`/`supabase`/`gitlab`/`cloudflare` entries in the existing 24px stroke style —
   or reuse the letter-avatar pattern the *Connected accounts* list already uses),
   connection state, and one CTA:
   - **GitHub** — state from `listInstallationsForViewer` (already fetched on this page):
     "Connected · {accountLogin}" with a "Manage on Feed" affordance, or the install CTA
     via the existing `buildInstallUrl` path (which already echoes the request origin).
   - **Supabase** — state from the already-fetched `connections`: "Connected · N
     project(s)" → anchors to the existing Supabase projects section below; unconnected →
     "Connect Supabase" → anchors to the connect form in `SupabaseConnections`.
   - **GitLab / Cloudflare** — same `connections` projection; the connect CTA reveals a
     paste-form island (§3.2.1) or, before §1.3 ships, renders as "Coming soon" — the card
     exists from day one so the model is visible before the flow is.
2. **Repositories section** — unchanged.
3. **Supabase projects section** — unchanged (`SupabaseConnections` island keeps connect /
   scan / disconnect).
4. **Connected accounts** — unchanged.

**3.2.1 New client islands for GitLab/Cloudflare paste flows.** One component,
`apps/web/components/console/provider-connect-form.tsx`, parameterized by provider: the
field set comes from the provider (GitLab: token + optional self-hosted instance URL;
Cloudflare: token + account picker fed by the validate endpoint), the POST target is the
same `POST /api/connections` the Supabase form already uses, and the failure surface is the
existing pattern — inline error + one `shake()` per failure (`motion.ts`), then
`router.refresh()`. Copy follows the Supabase island's trust discipline: name what the
grant allows, and on disconnect say plainly what happens to the stored secret.

**3.2.2 Error/return codes.** The page already maps `?error=` codes through `FEED_ERRORS`;
extend with the new flows (`gitlab-connect-failed`, `cloudflare-token-rejected`,
`oauth-state-mismatch`, …) and have the `callback/[provider]` routes redirect to
`/feed?connected=<provider>` / `/feed?error=<code>` — success gets a small confirmation
banner row beside the error banner.

### 3.3 Dashboard — the bottom section: Connect GitHub, then Supabase, then the rest

`apps/web/app/(app)/dashboard/page.tsx` currently ends its reading order with
`<Sites />` (Domains) then `<Repositories />`. Insert **`<ConnectApps />` after
`<Repositories />`** — the inventory's inventory, last, consistent with the page's own
comment that the bottom is "the reference material, not the news":

- New **server component** `apps/web/components/console/connect-apps.tsx` rendering the
  `Card`-pattern section (header row inside the hairline border, per the dashboard's Card
  helper) titled **"Connect your apps"** with the provider cards in `PROVIDER_APPS` order:
  **GitHub → Supabase → GitLab → Cloudflare**.
- Each card: icon, label, one-line state, CTA.
  - **GitHub** — "Connect GitHub" button goes **straight to the install URL**
    (`buildInstallUrl(...)`, same origin-echo logic the feed uses — pass the same
    `requestOrigin(await headers(), …)` call). When installations exist, the card reads
    "Connected · N repositories" and the CTA becomes "Manage on Feed" → `/feed#connect`.
  - **Supabase** — "Connect Supabase" → `/feed#connect` (the form lives on the feed, not
    duplicated here); state text "N project(s) connected" / "Not connected".
  - **GitLab / Cloudflare** — same pattern; "Coming soon" state until §1.3 ships.
- Data: extend the dashboard's existing `Promise.all` with
  `listInstallationsForViewer(viewer)` and `listConnectionsForViewer(viewer)` — both
  queries already exist in `packages/db`; no new SQL.
- The whole section participates in the existing motion island (`data-reveal=""` /
  `data-reveal-item=""` attributes, like `Sites` and `Repositories`).

Result: on a fresh account the dashboard ends with a calm, ordered set of "connect this
next" cards — GitHub first because it is the deepest integration, Supabase second because
it works today, the rest visibly queued.

---

## 4. Concrete build order (tied to files)

1. **DB migration** — widen `connectionProviderEnum` (+`gitlab`,+`cloudflare`), add
   `authKind`/`tokenExpiresAt`/`lastValidatedAt`, extend status enum with `'expired'`
   (`packages/db/src/schema.ts` + `pnpm db:deploy`). Generalize the origin validator into
   `apps/web/lib/origin.ts` with tests. No UI, no MCP.
2. **Provider registry + both UI surfaces** — `apps/web/lib/connection-providers.ts`,
   `apps/web/components/console/connect-apps.tsx`; feed hub (§3.2) and dashboard bottom
   section (§3.3). GitHub and Supabase are fully functional from this step; GitLab/Cloudflare
   render as "Coming soon". Ship this early — it is user-visible value with zero new risk.
3. **GitLab + Cloudflare PAT connect** — `gitlab-connect.ts`, `cloudflare-connect.ts`,
   extend `POST /api/connections` + add `validate/[provider]`, `provider-connect-form.tsx`
   island, `FEED_ERRORS` extensions. Turn the two "Coming soon" cards on.
4. **`packages/mcp-client`: config + registry + client** (pure, no I/O beyond fetch; the
   full unit suite of §5 must pass before anything consumes it). `allowedTools` filtering
   and token redaction land here, at the boundary, where they are testable.
5. **Bridge + first live use** — `bridge.ts`, wired into `run-repo-scan.ts` with
   **GitHub only, scan tier (read-only `allowedTools`)**, results feeding the existing
   report path. Prove connect → call → transform → teardown for one provider end-to-end.
6. **Circuit breaker (`failures.ts`)** — before any second provider is attached to a live
   run, per §2.1. Includes the `'expired'` status flip on repeated auth failure.
7. **Second provider on the bridge** (GitLab read-only) — the real test that nothing
   GitHub-specific leaked into the registry or bridge. Then verify the Supabase/GitLab/
   Cloudflare hosted MCP endpoints (§2.4 table) and flip on what checks out.
8. **Fix tier + writes** — extend `lib/fixes.ts` context-gathering (Phase A of §2.2), then
   GitHub write tools behind the ownership + entitlement gate. Ship writes last, on the
   connection type we are most confident about.
9. **`resultTransform` hardening** — tune redaction/caps per provider as real payloads are
   observed (§2.5); this is maintenance, not a gate.

---

## 5. Test checklist (what Strix tests, translated to this repo's stack)

The repo's test furniture: vitest per package (`turbo run test`), `msw` for fetch mocking,
colocated `test/` dirs (`packages/mcp-server/test/`, `apps/web/test/`).

**`packages/mcp-client/test/`**

- `config.test.ts` — schema rejects an http config without `url` (the port of
  `_check_transport_fields`); `JSON.stringify` of a config/entry/summary never contains the
  bearer token; defaults match the verified constants (`30/60s`, `maxConcurrentCalls: 4`).
- `registry.test.ts` — `statuses()` output contains exactly `{ name, provider, toolCount,
  dead }` and nothing else (the `McpConnectionStatus` non-secret contract, asserted by
  deep-equality); `clear()` empties; insertion order preserved in `names()`/`summaries()`.
- `client.test.ts` (msw) — `allowedTools` filter hides a disallowed tool from the parsed
  `tools/list` result entirely (not "rejects if called" — it must not appear); result
  transform runs on every call; truncation keeps structure past the cap; concurrent calls
  per connection respect `maxConcurrentCalls`.
- `failures.test.ts` (fake timers) — classification table (permission/protocol/transient/
  auth); backoff matches `min(8, 0.5·2^(n-1)) + jitter` bounds; connect failure skips the
  connection and the run continues; repeated auth failures flip status to `'expired'`.
- `bridge.test.ts` (msw + a stubbed vault) — origin-binding: a grant bound to origin X is
  **refused** when the endpoint origin differs; `'expired'`/`'error'` rows are skipped
  fail-open; teardown closes every session even when a step throws (finally-path test).

**`apps/web/test/`**

- Route tests with msw: `POST /api/connections` happy + per-provider rejection paths
  (GitLab 401 copy names the fix; Cloudflare `disabled`/`expired` token refused by name —
  the same "refuse by name" discipline as `validateAnonKey`'s service-role refusal);
  `install-url/[provider]` and `callback/[provider]` state-mismatch path; the 503
  unconfigured-deployment path on every new route.
- Feed/dashboard render tests: all four provider cards render in order
  (GitHub, Supabase, GitLab, Cloudflare) on **both** pages; disconnected state shows the
  connect CTA; the API-driven card content never includes a token field name.

**Gate:** `pnpm test && pnpm typecheck` (turbo) green before each build-order step merges.

---

## 6. What this plan deliberately does not decide

- **Per-provider console setup** — the GitHub App exists; a GitLab application (for the
  later OAuth path) and Cloudflare token-scope guidance are one-off console tasks done
  when their step ships.
- **Supabase's MCP tier** — Level 1 works today without MCP; Level 2 remains the
  scoped-Postgres-role flow per the deep-scan plan; a Management-API-PAT MCP tier is
  evaluated only when its hosted endpoint's auth model is verified (§2.4 table).
- **Phase B agent harness** — the dispatch trio (§2.2) is specified but unregistered
  until the fix tier actually gains a tool-calling loop; nothing in `packages/mcp-client`
  depends on which harness that turns out to be.
- **Cloudflare shim vs hosted endpoint** — decided by the §2.4 verification pass, not by
  this document.

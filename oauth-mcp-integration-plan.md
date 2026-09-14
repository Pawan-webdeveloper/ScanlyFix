# ScanlyFix: OAuth ↔ MCP Split — Integration Plan

**Source material:** every code pattern below was read directly out of `usestrix/strix`
(files: `strix/tools/mcp/config.py`, `loader.py`, `client.py`, `session.py`,
`registry.py`, `failures.py`, `naming.py`, `agent_tools.py`;
`strix/interface/cloud/http.py`, `spec.py`, `platform_cli.py`;
`strix/interface/utils.py`). Nothing here is invented from general MCP
knowledge — where I'm describing a mechanism, I'm describing what that file
actually does. Where you need to adapt something to your own stack (Next.js
routes, your DB, your job runner, Inngest, Supabase schema), I've flagged it
explicitly as **[ADAPT]**. Anything not flagged is close to drop-in.

---

## 0. The one-sentence architecture

> **OAuth owns trust. MCP owns interface. A short-lived bridge converts one into the other per scan/fix-run, and is torn down when the run ends.**

Two persistent things exist in your DB. Nothing else is persistent:

1. `integrations` — one row per user-connected provider (GitHub, GitLab,
   Supabase project, Cloudflare, whatever). Holds encrypted refresh/access
   tokens. Lives forever until the user disconnects.
2. Nothing MCP-related is persisted. An MCP connection is **built fresh, in
   memory, for the lifetime of one scan or one fix-run**, from the
   `integrations` row, and discarded when the run ends. This is exactly what
   Strix does — `McpRegistry` is built per-run in the runner and cleared when
   the run finishes (`registry.py` docstring: *"One `McpRegistry` is built per
   run... stored in the run context"*). There is no long-lived MCP server
   object sitting around holding a token in a global.

This matters more than it sounds: it means a leaked in-memory object, a stuck
process, a crashed worker — none of them leak a live authenticated session
past the job that used it.

---

## 1. Layer 1 — OAuth / "Direct Connection" (the trust layer)

### 1.1 What Strix's pattern teaches you, concretely

Strix has two separate OAuth-shaped flows and you should copy the *shape* of
both, applied to your own product:

**A. Platform login (`strix/interface/platform_cli.py`)** — an OAuth 2.0
*device authorization* flow (browser-based, polling), used because it's a
CLI. **[ADAPT]** You're a web app, so you want standard **Authorization Code +
PKCE**, not device flow — but keep everything downstream of "we now have a
token" identical to their pattern:

- `save_record()` → `write_secret_text(AUTH_PATH, json.dumps(record))`. The
  token is never held in a plain dict passed around your app; it's written
  once to one place, immediately, with restrictive file permissions (their
  `write_secret_text` helper — worth writing your own DB-side equivalent:
  encrypt-at-rest column, not a `varchar`).
- `_bind_login_record(record, app_url)` **[study this function specifically]**
  — the record stores *which origin issued this token*, not just the token.
- `_validate_stored_token_origin()` in `cloud/http.py` (lines 140–162) —
  **before every single use of a stored token**, it re-checks that the origin
  the token is about to be sent to matches the origin that issued it, and
  refuses with a hard error if they don't match:

  ```python
  if stored_origin != active_origin:
      raise CloudError(
          "the stored sign-in belongs to a different platform. Refusing to "
          "send its token...", exit_code=EXIT_AUTH,
      )
  ```

  **[ADAPT — but do not skip]**: your equivalent is "never send a user's
  GitHub token to any base URL except `api.github.com` / their GitHub
  Enterprise URL they configured." This is the single check that stops a
  compromised or misconfigured MCP server config from exfiltrating a stored
  token to an attacker's host. Build this as one shared function every
  outbound call goes through — not a check duplicated at each call site
  (Strix funnels every platform request through the one `request()` function
  in `http.py` for exactly this reason).

**B. Third-party Git provider connect (`strix/interface/cloud/spec.py`,
lines 857–892)** — this is the closer template for what you need:

```python
"integrations": {
    "list": Cmd("GET", "/integrations", "List the connected integrations."),
    "connect": Cmd("POST", "/integrations/{provider}/connect",
        "Connect a Git provider. The provider is gitlab or bitbucket.",
        body=_GIT_TOKEN_BODY),
    "validate": Cmd("POST", "/integrations/{provider}/validate",
        "Validate a Git provider token.", body=_GIT_TOKEN_BODY),
    "install": Cmd("POST", "/integrations/{provider}/install-url",
        "Create an installation link. The provider is github or slack. "
        "A person approves it.", link="url"),
    "disconnect": Cmd("DELETE", "/integrations/{provider}",
        "Disconnect an integration.", ...),
}
```

Notice the **split by provider type**:
- **GitHub / Slack** → `install-url` → GitHub App / Slack App install flow,
  a link the user approves (real OAuth-app pattern, installation ID comes
  back).
- **GitLab / Bitbucket** → `connect` + `validate` with a raw
  `access_token` field (`_GIT_TOKEN_BODY`, line 112) — i.e. a
  personal-access-token paste flow, because not every provider makes a
  GitHub-App-style OAuth install easy.

**[ADAPT] Your endpoint set, mirroring this exactly:**

```
GET    /api/integrations                       list connected providers
POST   /api/integrations/:provider/install-url  → returns OAuth authorize URL (github, gitlab, cloudflare, supabase)
GET    /api/integrations/:provider/callback     → OAuth redirect target, exchanges code for token
POST   /api/integrations/:provider/connect      → PAT-paste path for providers without app-install (fallback)
POST   /api/integrations/:provider/validate     → test the token actually works before saving
DELETE /api/integrations/:provider              → disconnect + revoke token at the provider
```

### 1.2 Data model **[ADAPT to your schema — this is the field list, not DDL]**

```
integrations
  id
  user_id / org_id
  provider              -- "github", "gitlab", "cloudflare", "supabase", ...
  auth_kind             -- "oauth_app" | "personal_access_token"
  encrypted_token        -- envelope-encrypted, never selected by default
  encrypted_refresh_token (nullable)
  token_expires_at       (nullable)
  issuer_origin           -- e.g. "https://github.com" — bind + validate on every use (§1.1)
  installation_id         (nullable, for GitHub App style)
  scopes                  -- what was actually granted
  connected_at
  last_validated_at
  status                  -- "active" | "expired" | "revoked" | "invalid"
```

Why `issuer_origin` is its own column and not assumed: it's the exact field
that makes `_validate_stored_token_origin` possible. Store it once at connect
time, check it every time you're about to use the token in an MCP config.

### 1.3 Non-negotiable security behaviors, lifted directly from the code

| Pattern | Where it's shown in Strix | Your equivalent |
|---|---|---|
| Never log or serialize the token | `session.py` docstring: *"the connection config... holds a live bearer credential and is kept here in memory only... never logged, serialized into the run's event stream, or written to disk"*; `McpConnectionEntry.config` docstring repeats it | Redact `encrypted_token` from every log line, error payload, and Sentry breadcrumb. Add a `repr`/serializer override so accidental `console.log(integration)` can't leak it. |
| Non-secret status projection | `McpConnectionStatus` dataclass (registry.py) carries only `name, provider, tool_count, dead` — explicitly *"No config, token, url, or purpose rides here."* | Your `/api/integrations` list endpoint returns `{provider, status, connected_at, scopes}` — never the token, never even a masked suffix unless you've decided that's safe. |
| SSRF-safe URL validation before any outbound call | `cloud/http.py` `_parse_origin_url()` (lines 283–313): rejects credentials-in-URL, non-http(s) schemes, non-ASCII hosts, stray whitespace, percent-encoded netloc tricks; `_is_loopback_host()` separately allows only same-origin loopback | Before you ever build an MCP `url` field from a user-supplied "instance_url" (self-hosted GitLab, self-hosted Supabase), run it through an equivalent allowlist check. This is the exact class of bug that turns "connect your GitLab" into "read our cloud metadata endpoint." |
| Bind uploads/URLs to a known-good host pattern | `_SUPABASE_STORAGE_HOST = re.compile(r"^[a-z0-9-]+\.supabase\.co$")` + `_validate_upload_url()` | If you ever accept a user-supplied Supabase project URL, validate it against the real `*.supabase.co` (or their self-hosted domain, explicitly allow-listed) pattern before using it as a fetch target. |
| Gate write/backend-reaching capability behind proven ownership | Your own site already does this! `scanlyfix.com` "Safety" section: *"Never probes a backend you have not proved you own... receive the capability to make that request only on a domain you have verified."* | **Apply this same rule to every OAuth-connected integration that can write, not just Supabase RLS / Firebase checks.** A "create PR" or "edit DNS record" action must require the same domain-verification gate your read-only Supabase/Firebase checks already require. Don't let OAuth-connect alone be sufficient permission to write — require verified ownership of the target domain/repo too. |

---

## 2. Layer 2 — MCP (the interface layer)

### 2.1 The connection config contract — copy this schema close to verbatim

`strix/tools/mcp/config.py` is the whole contract in ~90 lines. This is
directly reusable regardless of language:

```python
class BearerAuth(BaseModel):
    kind: Literal["bearer"] = "bearer"
    token: str = Field(min_length=1, repr=False)   # <-- repr=False, note this

class McpConnectionConfig(BaseModel):
    name: str                      # unique per run; namespaces the tools
    transport: Literal["http", "stdio"] = "http"
    url: str | None = None         # required for http
    auth: BearerAuth | None = None
    command: str | None = None     # required for stdio (you likely never need stdio — see §2.5)
    args: list[str] = []
    env: dict[str, str] = {}
    allowed_tools: list[str] | None = None   # allowlist gate
    notes: str | None = None                 # human-readable purpose, shown to the agent
    http_timeout_seconds: float = 30.0
    sse_read_timeout_seconds: float = 300.0
    session_timeout_seconds: float = 60.0
    max_concurrent_calls: int = 4
```

Two details worth deliberately keeping:

- **`repr=False` on the token field.** Trivial, and it's exactly the kind of
  thing that prevents an accidental debug print or stack trace from leaking a
  credential. Do the equivalent in whatever language you're in (custom
  `toString`/`__repr__`/serializer override).
- **`allowed_tools`** is enforced *at the transport layer*, not just checked
  before you show something to the LLM. In `client.py`'s `_build_server()`:
  `create_static_tool_filter(allowed_tool_names=config.allowed_tools)` is
  passed into the MCP server object itself, so a disallowed tool **never even
  appears in `list_tools()`** — the agent can't discover it, let alone call
  it. This is stronger than an app-level "if tool not in allowlist: reject"
  check written after the fact. **This is the mechanism you use to make
  "read-only scan" and "apply fix" different permission tiers on the exact
  same GitHub connection** — same OAuth token, two different
  `McpConnectionConfig`s with different `allowed_tools`, built for different
  job types.

### 2.2 Generic dispatch tools, not one tool per provider action

This is the part of the Strix design most worth stealing outright.
`registry.py`'s docstring explains the "before" state and why they changed
it:

> *"The old model turned every tool of every connected MCP server into its
> own agent tool, so a run with a handful of connections put dozens of
> provider tool schemas on the root agent's first LLM request."*

The fix: **three generic tools**, regardless of how many providers are
connected or how many tools each one exposes:

- `list_mcps` — "what connections do I have" (no args)
- `describe_mcp(connection)` — "what can this one connection do" (fetches
  tool schemas on demand, not up front)
- `call_mcp(connection, tool, args)` — actually run one tool

This is a direct token-budget and UX win for you: if a user has GitHub +
Supabase + Cloudflare connected, your fix-agent's system prompt doesn't grow
by three providers' worth of tool schemas every time you add an integration.
It grows by exactly zero — the agent discovers what's available at
call-time via `describe_mcp`. **[ADAPT]**: implement this as three actual
tool/function definitions in whatever agent framework you're using (your own
LLM tool-calling harness), each dispatching to the registry below.

### 2.3 Per-run registry — build it fresh, tear it down always

`McpRegistry` (registry.py) is intentionally dumb: a `dict[name →
McpConnectionEntry]`, built once per run, with `add()`, `get()`,
`summaries()`, `statuses()`, `clear()`. The important design decision is
**where it lives**: stored under one key (`MCP_REGISTRY_CONTEXT_KEY =
"mcp_registry"`) in the run's execution context, so every sub-agent in that
run shares the same live sessions instead of each one reconnecting.

**[ADAPT]**: if your fix-runs are single-process jobs (Inngest function, worker
job, whatever), build one registry object at the top of that job, pass it down
through whatever context object your job already threads through, and make
sure it's closed in a `finally`. Do not make this a singleton/global — a
global registry means job A's Supabase connection is reachable from job B.

### 2.4 The bridge: OAuth row → live MCP connection (the actual "split")

This is the one function that ties Layer 1 and Layer 2 together, and Strix
already wrote the exact shape you need — `attach_mcp_requests()` in
`client.py` (lines 341–374):

```python
async def attach_mcp_requests(requests, registry):
    """The one shared attach-and-populate path both the command-line and
    the SaaS/pro product go through, so all connecting and cleanup lives
    in one owner."""
    request_by_name = {r.config.name: r for r in requests}
    connections = await connect_mcp_servers([r.config for r in requests])
    for connection in connections:
        request = request_by_name[connection.name]
        registry.add(
            name=connection.name,
            session=connection.session,
            tool_count=connection.tool_count,
            purpose=request.purpose or connection.notes,
            provider=request.provider,
            result_transform=request.result_transform,   # <- see §2.6
        )
    return connections
```

Read the docstring on `McpConnectionRequest` in `registry.py` — this is
literally the OAuth→MCP bridge object:

> *"A source-agnostic request to attach one MCP connection to a run. The
> caller hands the engine an inert `config` (how to reach the server, its
> name, and any auth token) plus metadata, and never a live session."*

**[ADAPT] — your version of this pipeline, at the start of every scan/fix job:**

```
1. job starts, receives {user_id, integrations_requested: ["github", "supabase"]}
2. for each requested provider:
     row = db.integrations.get(user_id, provider)
     assert row.status == "active"
     decrypt row.encrypted_token  (in-process only, never returned from this function)
     validate row.issuer_origin against the fixed allowlist for that provider (§1.3)
     build McpConnectionConfig(
         name=provider,
         transport="http",
         url=PROVIDER_MCP_ENDPOINTS[provider],      -- fixed per provider, NOT user-supplied
         auth=BearerAuth(token=decrypted_token),
         allowed_tools=TOOL_TIER[job.kind][provider], -- "scan" vs "fix" tiers, see §2.1
         notes=f"{provider} account for {user}, connected {row.connected_at}",
     )
3. registry = McpRegistry()
4. await attach_mcp_requests(configs, registry)   -- connects everything, fail-open per connection
5. run the agent with `registry` in its context
6. finally: close every session in the registry, discard the registry object
```

The single most important line in that pipeline is step 2's "URL is fixed
per provider, not user-supplied" for hosted providers like GitHub — only
allow a user-supplied `url`/`instance_url` for genuinely self-hosted things
(self-hosted GitLab), and run *that* through the SSRF-safe validator from
§1.3 before ever putting it in a config.

### 2.5 Do you need `stdio` transport at all?

Strix supports `stdio` (spawn a local subprocess MCP server) because it's a
CLI tool running on the user's own machine. **[ADAPT — recommendation]**: you
almost certainly don't need this. Your fix-runs run in your infrastructure,
not the user's laptop, so every connection should be `transport: "http"`
against either the provider's own remote MCP endpoint (GitHub now ships one:
`https://api.githubcopilot.com/mcp/`, per Strix's own docs example) or a
small internal HTTP-MCP shim you write per provider that doesn't have a
public MCP server yet. Don't build subprocess-spawning into a multi-tenant
backend — that's a much bigger sandboxing problem than you need to take on
right now.

### 2.6 `result_transform` — your sanitizer hook, use it from day one

`McpConnectionEntry.result_transform` and `dispatch_mcp_call()` (client.py,
line 212) run a transform function on **every single tool result** before it
reaches the agent or gets logged, specifically called out as *"strix-pro's
sanitizer"*. This is the exact hook you want for two things:

1. **Redacting secrets a provider's own API might hand back** (e.g. a
   GitHub API response that happens to include another collaborator's email,
   or a Supabase describe-schema call that returns a connection string with
   embedded credentials).
2. **Truncating huge payloads** before they blow your LLM context — the
   `renderMcpTool` comment in the Go TUI code notes results are *"often
   multi-kilobyte JSON"* and deliberately not rendered in full to the
   terminal; apply the same discipline to what actually reaches your model's
   context window, not just what a human sees.

Wire this in per-connection at the same place you build the
`McpConnectionConfig` (§2.4 step 2) — pass a `result_transform` alongside it.

### 2.7 Failure handling — steal the state machine, not just the concept

`session.py` + `failures.py` implement a real circuit breaker per connection,
not just try/catch:

- A connect failure → connection is skipped for this run (fail-open, doesn't
  kill the whole job).
- A **call** failure is classified (`failures.classify()`) into kinds:
  `permission` (provider said no to *this* request — connection stays
  usable), `protocol` (malformed request — connection stays usable),
  transient/`transport` (retried with backoff+jitter,
  `_retry_delay()`: `min(8.0, 0.5 * 2**(attempt-1))` + jitter, up to
  `_MAX_ATTEMPTS = 3`), and permanent auth failure → connection is
  **quarantined** (temporarily marked dead) or **retired** (permanently, on
  repeated auth failure).
- Concurrency per connection is bounded (`max_concurrent_calls`, default 4,
  via a semaphore) so one connection can't monopolize your worker.

**[ADAPT]**: you don't need Python's `asyncio` task-supervision machinery
specifically (that whole file exists to solve a very Python/anyio-specific
cancellation bug), but you do need the *state machine*: per-connection
dead/live status, bounded retries with backoff on transient failures, and a
hard stop (mark integration `status: "invalid"` in your DB, prompt
re-auth) on repeated 401s so you're not hammering a revoked token.

---

## 3. Wiring it into your fix-application flow specifically

This is where your "not just scanning, digging deeper" ambition actually
lands. Two job *kinds*, same connections, different `allowed_tools`:

```
SCAN job  (read-only, matches your current safety promise)
  allowed_tools per provider = READ-ONLY tool names only
    github  -> ["get_repo", "list_files", "get_file_contents", "list_issues"]
    supabase -> ["list_tables", "get_policies"]   -- never "execute_sql" with writes

FIX job   (writes — the new capability)
  requires: domain/repo ownership already verified (existing gate, extended per §1.3 table)
  allowed_tools per provider = the above + write actions, explicitly enumerated
    github  -> [...READ..., "create_branch", "create_or_update_file", "create_pull_request"]
    supabase -> [...READ...]   -- you may choose to never allow Supabase writes at all; that's a product decision, and the allowlist is exactly the mechanism to enforce "we scan Supabase but never touch it"
```

The agent never gets a choice about which tier it's operating in — that's
decided by which `McpConnectionConfig` your job builder hands it (§2.4),
before the agent ever starts. This is the same "capability, not
config-outside-a-gate" pattern your own site already advertises for the
Supabase RLS check.

For the actual PR-creation step, mirror what Strix's own reporting tool
anticipates producing (`strix/tools/reporting/tool.py` mentions literal
GitHub/GitLab PR-suggestion blocks) — your fix-prompt generation (which you've
already built, per your landing page) becomes, in fix-mode, a sequence of
`call_mcp("github", "create_branch", ...)` →
`call_mcp("github", "create_or_update_file", ...)` →
`call_mcp("github", "create_pull_request", ...)` calls instead of a markdown
block the user pastes into Cursor themselves.

---

## 4. Concrete build order

1. **`integrations` table + encryption.** No MCP yet. Just get OAuth-connect
   working for GitHub first (most requested, has a real MCP endpoint already
   per §2.5), with the `issuer_origin` binding and status endpoint from §1.
2. **`McpConnectionConfig` equivalent + provider→URL/tool-tier constant
   map.** Pure data layer, no live connections yet.
3. **Registry + `attach_mcp_requests`-equivalent bridge (§2.4).** Wire it
   into one existing job type first (scan), read-only tools only. Prove
   connect → call → teardown works end to end for one provider.
4. **Generic dispatch tools (§2.2)** exposed to your agent, backed by the
   registry from step 3.
5. **Failure/circuit-breaker state machine (§2.7).** Do this before you add
   a second provider, not after — retrofitting retry/quarantine logic across
   multiple provider integrations at once is much more error-prone than
   building it once against GitHub and reusing it.
6. **Second provider (Supabase or Cloudflare)** — this is your real test
   that the abstraction in steps 2–4 is actually provider-agnostic and you
   didn't accidentally bake GitHub-specific assumptions into the registry.
7. **Fix-tier `allowed_tools` + ownership-verification gate (§3).** Ship
   write capability last, on the connection type you're most confident about
   (GitHub PR creation), behind the same domain-verification gate your
   Supabase/Firebase checks already use.
8. **`result_transform` sanitizers (§2.6)** — add per-provider as you learn
   what each provider's raw API responses actually leak.

---

## 5. Test checklist (mirrors what Strix itself tests)

Strix has dedicated tests for exactly the seams that break in practice —
build the same list against your stack:

- `test_mcp_client.py` equivalent: a connection that fails to connect is
  skipped, not fatal to the whole job.
- `test_runner_mcp.py` equivalent: registry is empty/absent gracefully when
  no integrations are connected — a scan with zero connections still runs.
- `mcp_test.go` / `render_test.go` equivalent (if you have any UI showing
  connection status): dead connections render distinctly from live ones,
  and the status view never contains the token, url, or raw config
  (`McpConnectionStatus` is your model for what the wire payload should
  contain).
- Origin-binding test (`_validate_stored_token_origin` equivalent): a token
  issued for one origin is refused when the configured base URL changes.
- SSRF test on `_parse_origin_url` equivalent: reject credentials-in-URL,
  loopback addresses (unless explicitly same-origin dev), cloud metadata IP
  ranges, non-ASCII hosts.
- Allowlist enforcement test: a tool not in `allowed_tools` does not appear
  in `describe_mcp` output at all, not just "is rejected if called."

---

## What I did *not* give you specifics on, on purpose

Anything below depends entirely on your stack and I don't have visibility
into it, so I've deliberately left it as a decision for you rather than
guessing:

- Your actual DB schema/migration syntax (Supabase/Postgres specifics,
  RLS policies on the `integrations` table itself).
- Which job runner (`Inngest`, per your privacy page) owns the job context
  object the registry gets threaded through, and how that context is
  already shaped in your codebase.
- Your specific OAuth app credentials/redirect URI registration per
  provider (GitHub App vs OAuth App choice, Cloudflare API token scopes,
  Supabase management API auth model — each provider's console setup is a
  one-off you'll do per integration).
- Your existing agent/LLM tool-calling harness's exact function-registration
  API — `list_mcps`/`describe_mcp`/`call_mcp` need to be implemented as
  whatever your framework calls "tools" or "functions," which I haven't seen.

# ScanlyFix: Scan Architecture Rebuild — Implementation Steps

This is the concrete build-out of the three gaps from the architecture
review: no queue, containers with a live path back into your app, and
"always execute in a container" even for checks that don't need one. Steps
are ordered so each one is shippable and testable on its own — you don't
need to do this in one big rewrite, and you shouldn't.

Where I don't know your stack (job runner, container host, DB schema) I've
marked **[ADAPT]** and given you the decision to make rather than guessing.
Where I do know it (you mentioned Inngest, and Supabase is your likely DB
given ScanlyFix's own Supabase-focused checks), I've written toward that.

---

## Phase 0 — Before touching infra: define the job contract

Do this first regardless of everything else, because every later phase reads
and writes this shape.

### 0.1 The `scan_jobs` table **[ADAPT — field list, not DDL]**

```
scan_jobs
  id (uuid, pk)                    -- THE scan_id, used everywhere downstream
  user_id / org_id
  repo_full_name                   -- "owner/repo"
  installation_id                  -- GitHub App installation used to access it
  commit_sha                       -- pin the exact commit scanned, not "main" (mutable ref)
  status                           -- queued | cloning | scanning | uploading_results | done | failed | timed_out
  tier                             -- "manifest_only" | "full_sandbox"  (see Phase 3)
  requested_at
  started_at
  finished_at
  error_message
  result_token_hash                -- see Phase 2.3 — hash of the single-use result token, not the token itself
  container_id                     -- last known sandbox handle, for reaping (Phase 4)
  attempt_count
```

Two decisions baked into this table on purpose, don't skip them:

- **Pin `commit_sha` at enqueue time**, not at scan time. If the user pushes
  between "click scan" and "container actually starts," you want to scan
  what you said you'd scan, and you want the result page to be able to say
  "this is what commit abc123 looked like," not "this is what main looked
  like at some ambiguous point."
- **`tier` is decided before a container is ever considered**, not inside
  the worker. This is what lets Phase 3 skip the container entirely for
  a big chunk of jobs.

### 0.2 The queue message is just `{scan_job_id}`

Nothing else. Not the repo URL, not a token, not scan config. The worker
looks everything up from `scan_jobs` by id when it picks the message up.
This one rule prevents an entire category of bug: stale config riding along
in a queue message that's now out of sync with the DB row (e.g. installation
got revoked after the job was enqueued but before a worker picked it up —
if the worker re-reads from the DB, it sees the current state; if the token
rode along in the message, it doesn't).

---

## Phase 1 — Put a queue between "user clicked scan" and "a container starts"

This is the highest-priority phase. It fixes the synchronous-pipeline
problem and costs you almost nothing to add.

### 1.1 Enqueue, don't execute, on the request path

Your current connect/scan-trigger handler should do exactly this and
nothing more:

```
POST /api/scans
  1. validate: user owns/has access to this installation_id + repo
  2. resolve commit_sha (GitHub API: GET /repos/{owner}/{repo}/commits/{ref})
  3. insert scan_jobs row, status = "queued"
  4. enqueue { scan_job_id }        -- [ADAPT: Inngest event, or SQS/BullMQ/pg-boss]
  5. return { scan_job_id } to the client immediately (HTTP 202, not 200)
```

**[ADAPT — Inngest specifics]**: if you're on Inngest, this is
`inngest.send({ name: "scan/requested", data: { scan_job_id } })` from the
route handler, and a separate `inngest.createFunction` listening for
`scan/requested` is your worker (Phase 2). Inngest gives you retries and
concurrency limits as config, which covers most of what a hand-rolled queue
needs — use `concurrency: { limit: N }` on that function as your first,
crude version of Phase 4's bounded-concurrency requirement. Don't build a
custom queue if Inngest is already in your stack; this is exactly what it's
for.

If you're not on a queue-capable runner: **[ADAPT — plain Postgres queue]**
a `scan_jobs` table with `status='queued'` and a worker polling
`SELECT ... FOR UPDATE SKIP LOCKED WHERE status='queued' LIMIT 1` is a
completely legitimate queue for your current scale. Don't reach for
SQS/RabbitMQ/Redis until you've outgrown this — it's one query, it's
transactional with the rest of your writes, and it's one less system to run.

### 1.2 The client polls or subscribes, it doesn't wait on the request

Your feed/scan-status page should poll `GET /api/scans/:id` (or subscribe to
a Supabase Realtime channel on the `scan_jobs` row **[ADAPT — you likely
already have this pattern from other parts of the product]**) instead of the
original request hanging open for however long a clone+scan takes. This
alone fixes "the request architecture couples scan duration to an HTTP
response," which is the thing that will start timing out reverse proxies and
serverless function limits as repos get bigger.

**Ship checkpoint:** after Phase 1, your scan trigger returns instantly and
a worker picks the job up asynchronously. Nothing about containers has
changed yet — that's next.

---

## Phase 2 — Fix the result-delivery direction (this is the security-critical one)

Do this before you optimize anything else. Right now, per your description,
the container that just executed a stranger's code is the thing calling
back into your main app with results. That's backwards. Fix the direction
of trust.

### 2.1 The worker owns the container, the container doesn't own the callback

The process that has your DB credentials is the **worker**, not the
sandbox. The worker:

1. Starts the container (Phase 3).
2. Waits for it to finish (with a hard timeout — Phase 4).
3. **Reads** the result out of the container itself — via the same sandbox
   client's file-read/exec-output mechanism you're already using to run the
   scanners, not via an inbound HTTP call the container makes.
4. Writes the result to your DB/object storage using its own, real
   credentials.
5. Tears the container down.

This single change means the untrusted code never holds a credential that
can write to your platform. It can produce output; it never gets to *decide
where that output goes*.

### 2.2 If you genuinely need the container to push (e.g. remote sandbox
backend with no readback API)

Some sandbox backends only support "container calls a URL" rather than
"orchestrator reads container output" — if that's your situation, don't
skip this, but shrink the blast radius to almost nothing:

- Mint a **single-use, single-scan-scoped token** at container start time:
  `result_token = random(32 bytes)`, store `sha256(result_token)` in
  `scan_jobs.result_token_hash`, hand the raw token to the container as an
  env var.
- The ingestion endpoint (`POST /api/scans/:id/result`) does exactly one
  thing: hash the presented token, compare to `result_token_hash` for that
  `scan_job_id`, and if it matches **and the job status is still
  "scanning"** (not already "done" — reject replays), accept the payload.
  Then immediately invalidate it (`result_token_hash = null`,
  `status = 'uploading_results'`) so it cannot be called twice.
- **Validate the payload against a strict schema before doing anything else
  with it** — no `JSON.parse` into a shape you then trust, no rendering any
  field as HTML anywhere without escaping, no treating any URL/string field
  in the scanner output as something you'll later fetch or execute. Treat
  scanner output as attacker-controlled input, because it came from a
  process that ran attacker-controlled code. This is the same class of
  requirement as the SSRF-safe URL validation and origin-binding pattern —
  every boundary where untrusted-derived data crosses into your trusted
  system needs an explicit gate, not an assumption.

### 2.3 Never let the container reach anything except the target repo

Whichever direction results flow, the container's network egress should be
default-deny except for exactly what a clone + scan needs: GitHub (for the
clone, if you're not shallow-fetching via API), and the package registry
domains a dependency-scan step legitimately needs (`registry.npmjs.org`,
`pypi.org`, etc., if OSV or a build step needs them). No egress to your own
app's internal network, no egress to arbitrary domains discovered in the
target repo. **[ADAPT to your container host]**: on plain Docker this is a
custom bridge network with an egress-filtering proxy or `iptables` rules; on
Fly Machines/Fargate/Cloud Run it's a security-group/firewall rule; on
Kubernetes it's a `NetworkPolicy`. Pick whichever your Phase 3 host actually
supports, but don't ship Phase 3 without picking one.

**Ship checkpoint:** after Phase 2, even if everything else in the pipeline
stayed identical, a hostile repo can no longer use your scan pipeline as a
path into your production app.

---

## Phase 3 — Split "needs a container" from "just needs file contents"

This is the phase that actually reduces your cost and attack surface, not
just contains it. Not every check needs execution.

### 3.1 Classify your checks

Go through your current scanner list and split it honestly:

- **`manifest_only`** — anything that reads `package.json`,
  `package-lock.json`, `requirements.txt`, `go.mod`, `Gemfile.lock`, etc.,
  and compares against a vulnerability DB. **This is OSV-scanner's entire
  input.** It needs file *contents*, not a working checkout, not `npm
  install`, not a build.
- **`full_sandbox`** — anything that needs to actually run code, install
  dependencies to inspect installed artifacts, execute a build step, or do
  dataflow/taint analysis across a real checkout. This is where "another
  scanner" you mentioned probably lives — audit it specifically: does it
  literally run `npm install`/`pip install`/build scripts on the target
  repo? If yes, it belongs here and it is the highest-risk part of your
  entire pipeline (arbitrary `postinstall` / `setup.py` execution from
  a repo you don't control). If it only *parses* files without executing
  anything, it can move to `manifest_only` too.

### 3.2 `manifest_only` path — no container at all

```
1. worker calls GitHub API: GET /repos/{owner}/{repo}/contents/{path}?ref={commit_sha}
   for each manifest/lockfile path relevant to detected languages
   (walk the repo tree via GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
   to find them, capped at a sane file-count/size limit)
2. run OSV-scanner (or equivalent) against the fetched file contents directly
   -- this can run in-process or in a short-lived, shared, resource-capped
   worker process, not a fresh container per scan
3. write results
```

No clone, no container spin-up, no per-scan Docker overhead, and this whole
path never executes a single line of the target repo's code. This is
directly comparable to what CheckVibe does for its core scanning — pulling
what's needed without granting execution — and it's worth doing here for
exactly the same reason: cheaper, faster, and there's no container to
escape from if there's no container.

**[ADAPT]**: GitHub App installation tokens are scoped to the repos it was
granted, so use the installation token for these API calls, not a clone —
you already have this token from Phase 0's `installation_id`.

### 3.3 `full_sandbox` path — this is where Phase 4's isolation matters

Only jobs that genuinely need to execute code take this path. Fewer jobs
hitting this path is itself a scalability win — you've cut your container
fleet size by however many checks moved to 3.2.

**Ship checkpoint:** after Phase 3, only a fraction of scans spin up a
container at all, and you have an explicit, auditable list of exactly which
scanners are allowed to execute code — instead of "everything runs in a
container by default."

---

## Phase 4 — Harden the `full_sandbox` path itself

For whatever's left after Phase 3, apply the isolation discipline the
current setup is missing.

### 4.1 Shallow clone, always

```
git clone --depth 1 --branch <commit_sha-resolved-ref> --single-branch <clone_url> .
```

**[ADAPT]**: if you need the exact pinned `commit_sha` and it's not the tip
of a branch, `git fetch --depth 1 origin <sha> && git checkout <sha>` is the
equivalent. Either way: no full history, ever. A repo with years of history
costs you clone time and disk for zero scanning value in the SAST/dependency
case.

### 4.2 Resource limits, not defaults

Every container gets explicit, enforced caps — not "whatever Docker
defaults to":

- CPU: e.g. `--cpus=1` (or your host's equivalent quota)
- Memory: hard cap with OOM-kill, e.g. `--memory=1g`, no swap
- PID limit: `--pids-limit=256` — stops fork-bombs from a malicious
  `postinstall` script cold
- Disk: a size-capped tmpfs or quota'd volume for `/workspace`, not
  unbounded host disk
- **Wall-clock timeout, enforced by the worker, independent of the
  container's own behavior**: the worker starts a timer when it starts the
  container and force-kills + tears down at, say, 5 minutes, regardless of
  whether the scan process inside thinks it's still working. Never trust
  the workload to self-terminate.

### 4.3 One container per job, no exceptions, always torn down

- Key every container by `scan_job_id`, one-to-one, never reused across
  jobs — a cache-and-reuse pattern makes sense for a long-lived interactive
  agent session; it's the wrong model for "run once against untrusted code
  and throw it away."
- Teardown must run in a `finally`/equivalent that fires on success,
  failure, *and* timeout — and it must be best-effort/non-blocking: a
  teardown failure logs and moves on, it does not prevent the next job from
  starting. Keep a `container_id` on the `scan_jobs` row (Phase 0) so a
  periodic reaper job can find and kill anything that's still running past
  its expected lifetime — treat "the happy-path teardown ran" as the common
  case, not the only case you plan for.
- Run a scheduled reaper (cron / Inngest scheduled function) that queries
  for containers whose `scan_jobs.status` is still `scanning` well past a
  reasonable max duration, and force-kills them. This is your safety net
  for every failure mode Phase 4.2's timeout was supposed to catch but
  didn't (worker crashed mid-job, host restarted, etc.).

### 4.4 Where does this run, relative to your API host?

**[ADAPT — this is the decision only you can make, based on budget/infra
maturity, but make it explicitly rather than by default]**:

- **Minimum bar, do this even if you do nothing else in this section**: the
  container host is a separate machine/service from whatever serves your
  Next.js app and holds your DB credentials. Not the same box, not a
  sibling container spawned by mounting the API server's Docker socket.
- **Reasonable next step**: a small fleet of worker VMs/nodes dedicated to
  running scan containers, with the network egress rule from §2.3 applied
  at the fleet level.
- **Where this naturally goes at real scale**: a managed sandboxing
  platform (Fly Machines, Modal, E2B) or Kubernetes with gVisor/Kata
  runtimeClass, so "container escape reaches the host" stops being a risk
  you're carrying yourself. You don't need this on day one — you do need
  the *interface* to your sandbox-starting code to not assume "local Docker
  forever," so that swapping the backend later is a config change, not a
  rewrite. Put one function behind this — `startSandbox(job) ->
  {containerId, exec, readFile}` — and only that function knows whether
  it's talking to local Docker, a remote Docker daemon, or a hosted sandbox
  API. Everything else in your worker code calls that interface and
  shouldn't care which backend is behind it.

**Ship checkpoint:** after Phase 4, the containers that do run are
resource-bounded, network-restricted, individually torn down and reaped,
and running on infrastructure that isn't your API host.

---

## Phase 5 — Observability (small, but you'll need it immediately)

Add these alongside Phase 1–4, not after:

- Per-`scan_jobs` row: `attempt_count`, `error_message` — so a failed scan
  is debuggable from the DB row alone, not from grepping worker logs.
- A dashboard/metric for: queue depth, in-flight container count, average
  scan duration by tier, timeout rate. This is what tells you *when* to
  move from "reasonable next step" to "real scale" in §4.4 — not a guess.
- Alert on: reaper actually finding and killing something (means Phase 4.2's
  timeout didn't work as expected — investigate, don't just let the reaper
  quietly paper over it every time).

---

## Suggested build order (map back to what ships when)

1. **Phase 0 + Phase 1** — one sprint. Zero behavior change to scanning
   itself, just decouples the request from execution. Immediately fixes
   your synchronous-pipeline problem.
2. **Phase 2** — one sprint, security-critical, do this before you let scan
   volume grow at all. This is the one I'd least want to leave for later.
3. **Phase 3.1 + 3.2** — classify your checks, move OSV-scanner (and
   anything else manifest-based) off the container path entirely. This is
   likely your biggest single cost/complexity reduction for the least
   effort, since it probably guts a large fraction of your current
   container volume immediately.
4. **Phase 4** — harden whatever's left running in `full_sandbox`. Do the
   resource limits and shallow-clone immediately (cheap); treat the
   infra-location decision (§4.4) as an explicit choice revisited as volume
   grows, not a one-time decision you're locked into.
5. **Phase 5** — build alongside 1–4, not as a separate phase at the end;
   you want the dashboard in place before you need it to diagnose
   something.

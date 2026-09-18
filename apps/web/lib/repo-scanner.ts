/**
 * The seam between the repo-scan job and the worker that does the work.
 *
 * Phase A (this file) returns canned findings for a single synthetic
 * critical finding, so the queue → persist → page loop is end-to-end
 * testable without GitHub credentials and without the worker container.
 *
 * Phase B replaces the body with an HTTP POST to SCANLYFIX_REPO_SCANNER_URL
 * (mirroring the way the site `runScanJob` calls the browser scanner). The
 * signature here is the contract: anything that does not fit a `RepoWorkerScan`
 * does not belong on this call. Keeping the seam thin means swapping the
 * implementation does not leak worker details into the Inngest function or
 * the executor.
 */

import 'server-only'
import type { RepoScanProfile } from '@scanlyfix/db'
import type { RepoFinding, RepoCheckError } from '@scanlyfix/repo-checks'
import { serverEnv } from '@/lib/env.ts'

export interface RepoWorkerRequest {
  installationId: number
  owner: string
  name: string
  defaultBranch: string
  profile: RepoScanProfile
}

export interface RepoWorkerResult {
  findings: RepoFinding[]
  errors: RepoCheckError[]
}

/**
 * Run a repo scan through the worker. Throws on our own failures (network,
 * auth, the worker not configured) and returns a `RepoWorkerResult` for the
 * rest, so the executor can `completeRepoScan` with the findings regardless
 * of how many came back.
 */
export async function runRepoScan(request: RepoWorkerRequest): Promise<RepoWorkerResult> {
  if (serverEnv.repoScannerConfigured) {
    // Real call. Guarded so a worker-less environment stays on the stub, and
    // the real path ships by setting the two env vars — the executor does not
    // change.
    return callWorker(request)
  }
  return stubScan(request)
}

/**
 * The worker's scan endpoint, derived from the configured base URL.
 *
 * SCANLYFIX_REPO_SCANNER_URL names the SERVICE, not the route — the same way
 * the site scanner's URL is configured and the same value .env.example
 * documents (`http://github-scanner.scanlyfix.svc.cluster.local:8081`). The
 * path is this code's business: posting to the bare base URL hit the worker's
 * 404 and every scan failed as `repo scanner responded 404: {"error":"Not
 * found"}`. A URL that already carries `/scan` is left alone so both forms work.
 */
function scanEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return base.endsWith('/scan') ? base : `${base}/scan`
}

async function callWorker(request: RepoWorkerRequest): Promise<RepoWorkerResult> {
  const res = await fetch(scanEndpoint(serverEnv.repoScannerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-scanner-token': serverEnv.repoScannerToken },
    body: JSON.stringify(request),
    // A clone + gitleaks + osv-scanner run is closer to a minute than to a
    // request; the worker has its own timeout, so 5 minutes is the cap.
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (!res.ok) {
    throw new Error(`repo scanner responded ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as { findings: RepoFinding[]; errors: RepoCheckError[] }
  return { findings: json.findings ?? [], errors: json.errors ?? [] }
}

/**
 * Phase A stub: a single critical finding per scan, so a worker-less
 * environment can prove the queue persists, the page renders, and the
 * severity ordering is honoured. Real findings start arriving in Phase B.
 */
function stubScan(request: RepoWorkerRequest): Promise<RepoWorkerResult> {
  return Promise.resolve({
    findings: [
      {
        checkId: 'supply-chain.pr-target-injection',
        category: 'supply-chain',
        severity: 'critical',
        title: 'pull_request_target checks out PR head (script injection)',
        description:
          `Stub critical finding for ${request.owner}/${request.name}. The real worker would ` +
          'read the actual .github/workflows/*.yml files; this stub proves the queue → persist ' +
          '→ report loop.',
        remediation: 'Replace pull_request_target with pull_request for any workflow that must run the PR code.',
        fixPrompt:
          'This is a stub finding from the Phase A worker placeholder; no action is required. ' +
          'The real worker ships in Phase B.',
      },
    ],
    errors: [],
  })
}

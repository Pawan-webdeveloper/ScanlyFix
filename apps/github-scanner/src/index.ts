/**
 * The repo-scanner worker's HTTP surface.
 *
 * Mirrors apps/scanner: one shared-secret token, fail-closed, node:http rather
 * than a framework. The web app's Inngest step (lib/repo-scanner.ts) is the only
 * intended caller; nothing else should be able to reach this.
 *
 * ## Fail closed, deliberately and loudly
 *
 * This service clones arbitrary GitHub repositories and executes pinned scanner
 * binaries over them. SCANLYFIX_REPO_SCANNER_TOKEN is REQUIRED: with no token
 * configured the process refuses to start rather than listening without
 * authentication. There is no development escape hatch, because the development
 * escape hatch is what ends up deployed.
 *
 * ## Endpoints
 *   GET  /health   — liveness; reports the REGISTERED tool versions (no exec).
 *   GET  /version  — runs each binary and reports pinned vs detected versions.
 *   POST /scan     — the scan seam. In this build the GitHub clone pipeline is
 *                    not wired yet, so a valid request is answered 501 rather
 *                    than with fake findings; see runScan.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { runRepoChecks } from '@scanlyfix/repo-checks'
import { detectToolVersions, registeredToolVersions } from './tools.ts'
import { parseScanRequest, type ScanRequest } from './request.ts'
import { githubConfigured, mintInstallationToken } from './auth.ts'
import { buildRepoApiContext } from './github.ts'
import { cloneAndScan, type CloneHandle } from './deep.ts'

const PORT = Number(process.env['PORT'] ?? 8081)
const TOKEN = process.env['SCANLYFIX_REPO_SCANNER_TOKEN'] ?? ''

/** A clone + gitleaks + osv-scanner run is heavy; serialize them. */
const MAX_CONCURRENT_SCANS = 1
const MAX_BODY_BYTES = 8 * 1024
/** Below the web executor's 5-minute HTTP cap, so we fail the scan before it does. */
const SCAN_TIMEOUT_MS = 4 * 60_000

if (!TOKEN) {
  console.error(
    'SCANLYFIX_REPO_SCANNER_TOKEN is not set. This service clones GitHub repositories and runs\n' +
      'secret/vulnerability scanners over them; without a shared secret anyone who can reach the\n' +
      'port can trigger scans and read the findings. Refusing to start.',
  )
  process.exit(1)
}

if (!githubConfigured()) {
  console.error(
    'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are not set. This service mints its own GitHub App\n' +
      'installation tokens to clone repositories; without them it cannot authenticate to GitHub.\n' +
      'Refusing to start rather than accepting scans that will always fail.',
  )
  process.exit(1)
}

let inFlight = 0

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error('unhandled', error)
    send(response, 500, { error: 'Internal error' })
  })
})

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'GET' && request.url === '/health') {
    // Liveness only: report the declared toolchain without exec-ing binaries.
    return send(response, 200, { ok: true, inFlight, tools: registeredToolVersions() })
  }

  const isVersion = request.method === 'GET' && request.url === '/version'
  const isScan = request.method === 'POST' && request.url === '/scan'
  if (!isVersion && !isScan) {
    return send(response, 404, { error: 'Not found' })
  }
  if (!authorized(request)) {
    // No detail: an unauthenticated caller learns nothing about why.
    return send(response, 401, { error: 'Unauthorized' })
  }

  if (isVersion) {
    const tools = await detectToolVersions()
    return send(response, 200, { node: process.version, tools })
  }

  // POST /scan
  if (inFlight >= MAX_CONCURRENT_SCANS) {
    response.setHeader('retry-after', '5')
    return send(response, 503, { error: 'Busy' })
  }

  let body: unknown
  try {
    body = JSON.parse(await readBody(request))
  } catch {
    return send(response, 400, { error: 'Body must be JSON' })
  }

  const parsed = parseScanRequest(body)
  if (!parsed.ok) {
    return send(response, 400, { error: parsed.error })
  }

  inFlight += 1
  const startedAt = performance.now()
  try {
    const result = await runScan(parsed.value)
    send(response, result.status, { ...result.body, durationMs: Math.round(performance.now() - startedAt) })
  } finally {
    inFlight -= 1
  }
}

/**
 * The scan seam: mint an installation token, assemble the shallow API context,
 * add a bounded clone + gitleaks/osv for a deep scan, then run the repo checks
 * and return their findings. A failure here is a non-2xx the web executor
 * records as a `failed` scan; individual check failures ride back in `errors`.
 */
async function runScan(request: ScanRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS)
  timer.unref()

  try {
    return await scan(request, controller.signal)
  } catch (error) {
    console.error(`scan ${request.owner}/${request.name} failed`, error)
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: controller.signal.aborted ? 504 : 502,
      body: { error: message, findings: [], errors: [] },
    }
  } finally {
    clearTimeout(timer)
  }
}

async function scan(request: ScanRequest, signal: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await mintInstallationToken(request.installationId)
  const api = await buildRepoApiContext(token, request.owner, request.name, request.defaultBranch)

  let clone: CloneHandle | undefined
  if (request.profile === 'deep') {
    clone = await cloneAndScan(token, request.owner, request.name, request.defaultBranch, request.historyDepth, signal)
  }

  try {
    const { findings, errors } = await runRepoChecks({
      owner: request.owner,
      name: request.name,
      defaultBranch: request.defaultBranch,
      api,
      clone: clone?.context,
    })
    return { status: 200, body: { findings, errors } }
  } finally {
    clone?.cleanup()
  }
}

/**
 * Constant-time comparison. A token check that returns early on the first wrong
 * byte leaks the token one character at a time to anyone patient enough to
 * measure the difference.
 */
function authorized(request: IncomingMessage): boolean {
  // Matches the header apps/web's lib/repo-scanner.ts sends.
  const presented = request.headers['x-scanner-token']
  const header = Array.isArray(presented) ? presented[0] : presented
  const a = Buffer.from(header ?? '')
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}

server.listen(PORT, () => console.log(`scanlyfix github-scanner listening on :${PORT}`))

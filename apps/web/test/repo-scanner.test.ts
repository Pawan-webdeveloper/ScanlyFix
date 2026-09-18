/**
 * The web side's call into the repo-scanner worker.
 *
 * The regression: SCANLYFIX_REPO_SCANNER_URL names the worker SERVICE (that is
 * what .env.example documents and how the site scanner's URL is configured),
 * but the code POSTed to it verbatim — hitting the worker's 404 and failing
 * every scan with `repo scanner responded 404: {"error":"Not found"}` even
 * though the service was up and the token was right.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRepoScan } from '../lib/repo-scanner.ts'

const REQUEST = {
  installationId: 1,
  owner: 'acme',
  name: 'site',
  defaultBranch: 'main',
  profile: 'shallow' as const,
}

function stubWorker() {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ findings: [], errors: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('runRepoScan → worker', () => {
  it('appends /scan to the configured service URL', async () => {
    vi.stubEnv('SCANLYFIX_REPO_SCANNER_URL', 'http://github-scanner.scanlyfix.svc.cluster.local:8081')
    vi.stubEnv('SCANLYFIX_REPO_SCANNER_TOKEN', 'tok')
    const { calls } = stubWorker()

    await runRepoScan(REQUEST)

    expect(calls).toEqual(['http://github-scanner.scanlyfix.svc.cluster.local:8081/scan'])
  })

  it('does not double the path when the URL already ends in /scan', async () => {
    vi.stubEnv('SCANLYFIX_REPO_SCANNER_URL', 'https://worker.example.com/scan/')
    vi.stubEnv('SCANLYFIX_REPO_SCANNER_TOKEN', 'tok')
    const { calls } = stubWorker()

    await runRepoScan(REQUEST)

    expect(calls).toEqual(['https://worker.example.com/scan'])
  })

  it('stays on the stub — no HTTP at all — when the worker is not configured', async () => {
    vi.stubEnv('SCANLYFIX_REPO_SCANNER_URL', '')
    vi.stubEnv('SCANLYFIX_REPO_SCANNER_TOKEN', '')
    const { fetchMock } = stubWorker()

    const result = await runRepoScan(REQUEST)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.findings).toHaveLength(1)
  })
})

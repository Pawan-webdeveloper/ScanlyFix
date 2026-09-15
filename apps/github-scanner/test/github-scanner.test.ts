import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_HISTORY_DEPTH, parseScanRequest } from '../src/request.ts'
import { GITLEAKS_VERSION, OSV_SCANNER_VERSION, registeredToolVersions } from '../src/tools.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dockerfile = readFileSync(join(here, '..', 'Dockerfile'), 'utf8')

function dockerArg(name: string): string {
  const match = dockerfile.match(new RegExp(`ARG ${name}=([^\\s]+)`))
  if (!match || !match[1]) throw new Error(`ARG ${name} not found in Dockerfile`)
  return match[1]
}

/**
 * The Dockerfile pins the binaries and verifies their checksums at build time;
 * src/tools.ts repeats the same pins so the running service can report them.
 * These two MUST agree, so the test fails the moment they drift apart.
 */
describe('registered tool versions stay in sync with the Dockerfile pins', () => {
  it('gitleaks pin matches the Dockerfile', () => {
    expect(GITLEAKS_VERSION).toBe(dockerArg('GITLEAKS_VERSION'))
  })
  it('osv-scanner pin matches the Dockerfile', () => {
    expect(OSV_SCANNER_VERSION).toBe(dockerArg('OSV_SCANNER_VERSION'))
  })
  it('registeredToolVersions exposes both pins', () => {
    expect(registeredToolVersions()).toEqual({
      gitleaks: GITLEAKS_VERSION,
      osvScanner: OSV_SCANNER_VERSION,
    })
  })
})

describe('parseScanRequest', () => {
  const valid = { installationId: 42, owner: 'octocat', name: 'hello-world', defaultBranch: 'main' }

  it('accepts a minimal valid request, defaulting to shallow', () => {
    const result = parseScanRequest(valid)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ ...valid, profile: 'shallow' })
  })

  it('accepts a deep profile', () => {
    const result = parseScanRequest({ ...valid, profile: 'deep' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.profile).toBe('deep')
  })

  it('accepts and passes through a bounded historyDepth', () => {
    const result = parseScanRequest({ ...valid, historyDepth: 500 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.historyDepth).toBe(500)
  })

  it('clamps historyDepth to the cap', () => {
    const result = parseScanRequest({ ...valid, historyDepth: MAX_HISTORY_DEPTH + 999 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.historyDepth).toBe(MAX_HISTORY_DEPTH)
  })

  it('ignores unknown fields', () => {
    const result = parseScanRequest({ ...valid, somethingElse: 1 })
    expect(result.ok).toBe(true)
  })

  it('rejects a non-object body', () => {
    expect(parseScanRequest('nope').ok).toBe(false)
    expect(parseScanRequest(null).ok).toBe(false)
  })

  it.each([
    ['installationId', { ...valid, installationId: 0 }],
    ['installationId', { ...valid, installationId: 'x' }],
    ['owner', { ...valid, owner: '' }],
    ['name', { ...valid, name: '   ' }],
    ['defaultBranch', { ...valid, defaultBranch: null }],
    ['historyDepth', { ...valid, historyDepth: -1 }],
    ['historyDepth', { ...valid, historyDepth: 'deep' }],
    ['profile', { ...valid, profile: 'full' }],
    ['profile', { ...valid, profile: { deep: true } }],
  ])('rejects a bad %s', (_field, body) => {
    const result = parseScanRequest(body)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})

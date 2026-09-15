/**
 * Deep-check behaviour: the two checks that read the cloned tree fire only when
 * a `clone` payload is present and stay silent on a shallow scan.
 */

import { describe, expect, it } from 'vitest'
import type { RepoCloneContext } from '../src/types.ts'
import { runRepoChecks } from '../src/registry.ts'
import { makeRepoContext } from './helpers.ts'

function clone(partial: Partial<RepoCloneContext>): RepoCloneContext {
  return {
    rootDir: '/tmp/repo',
    fileIndex: [],
    readFile: () => null,
    gitLog: [],
    gitleaks: [],
    osv: [],
    ...partial,
  }
}

describe('secrets.committed-secrets', () => {
  it('stays silent on a shallow scan (no clone)', async () => {
    const { findings } = await runRepoChecks(makeRepoContext())
    expect(findings.some((f) => f.checkId === 'secrets.committed-secrets')).toBe(false)
  })

  it('reports leaked secrets as critical with each location in evidence', async () => {
    const { findings } = await runRepoChecks(
      makeRepoContext({
        clone: clone({
          gitleaks: [
            { rule: 'generic-api-key', file: 'src/config.ts', line: 3, sample: 'generic-api-key (abc12345)' },
            { rule: 'aws-access-token', file: '.env', line: 1, sample: 'aws-access-token (def67890)' },
          ],
        }),
      }),
    )
    const finding = findings.find((f) => f.checkId === 'secrets.committed-secrets')
    expect(finding?.severity).toBe('critical')
    expect((finding?.evidence as { secrets: unknown[] }).secrets).toHaveLength(2)
  })
})

describe('dependencies.known-vulnerabilities', () => {
  it('stays silent on a shallow scan (no clone)', async () => {
    const { findings } = await runRepoChecks(makeRepoContext())
    expect(findings.some((f) => f.checkId === 'dependencies.known-vulnerabilities')).toBe(false)
  })

  it('reports vulnerabilities with the worst severity found', async () => {
    const { findings } = await runRepoChecks(
      makeRepoContext({
        clone: clone({
          osv: [
            { package: 'lodash', version: '4.17.20', vulnId: 'GHSA-1', severity: 'HIGH', fixed: '4.17.21' },
            { package: 'minimist', version: '1.2.5', vulnId: 'GHSA-2', severity: 'LOW', fixed: null },
          ],
        }),
      }),
    )
    const finding = findings.find((f) => f.checkId === 'dependencies.known-vulnerabilities')
    expect(finding?.severity).toBe('high')
    expect((finding?.evidence as { vulnerabilities: unknown[] }).vulnerabilities).toHaveLength(2)
  })

  it('maps CRITICAL to critical', async () => {
    const { findings } = await runRepoChecks(
      makeRepoContext({
        clone: clone({ osv: [{ package: 'x', version: '1', vulnId: 'GHSA-3', severity: 'CRITICAL', fixed: null }] }),
      }),
    )
    expect(findings.find((f) => f.checkId === 'dependencies.known-vulnerabilities')?.severity).toBe('critical')
  })
})

/**
 * Runner guarantees: one broken repo check must never sink a scan, output order
 * must be deterministic, and the registry must be the single source of truth for
 * what a repo scan runs. Mirrors the site engine's registry.test.ts.
 */

import { describe, expect, it } from 'vitest'
import type { RepoCheck, RepoFinding } from '../src/types.ts'
import { allRepoChecks, runRepoChecks } from '../src/registry.ts'
import { makeRepoContext } from './helpers.ts'

const finding = (checkId: string, severity: RepoFinding['severity']): RepoFinding => ({
  checkId,
  category: 'ci-cd',
  severity,
  title: checkId,
  description: 'synthetic',
  remediation: 'synthetic',
  fixPrompt: 'synthetic',
})

const emitting = (id: string, severity: RepoFinding['severity']): RepoCheck => ({
  id,
  category: 'ci-cd',
  title: id,
  run: () => [finding(id, severity)],
})

describe('allRepoChecks', () => {
  it('registers every check under a unique, category-prefixed id', () => {
    expect(allRepoChecks).toHaveLength(21)
    const perPillar = Object.fromEntries(
      ['secrets', 'supply-chain', 'ci-cd', 'code-quality', 'dependencies', 'governance'].map((pillar) => [
        pillar,
        allRepoChecks.filter((c) => c.category === pillar).length,
      ]),
    )
    // Shallow pillars plus the two deep checks (secrets from gitleaks,
    // dependencies from osv-scanner). code-quality still arrives later.
    expect(perPillar).toEqual({
      secrets: 1,
      'supply-chain': 5,
      'ci-cd': 8,
      'code-quality': 0,
      dependencies: 1,
      governance: 6,
    })

    expect(new Set(allRepoChecks.map((c) => c.id)).size).toBe(allRepoChecks.length)
    for (const check of allRepoChecks) {
      expect(check.id, `${check.id} must be dot-namespaced lowercase`).toMatch(/^[a-z]+(-[a-z]+)*(\.[a-z0-9-]+)+$/)
      expect(check.id.startsWith(`${check.category}.`), `${check.id} must start with its category`).toBe(true)
    }
  })
})

describe('runRepoChecks', () => {
  it('isolates a crashing check instead of failing the scan', async () => {
    const crashing: RepoCheck = {
      id: 'test.crash',
      category: 'ci-cd',
      title: 'crash',
      run: () => {
        throw new Error('boom')
      },
    }
    const { findings, errors } = await runRepoChecks(makeRepoContext(), [
      crashing,
      emitting('test.ok', 'low'),
    ])
    expect(findings.map((f) => f.checkId)).toEqual(['test.ok'])
    expect(errors).toEqual([{ checkId: 'test.crash', message: 'boom' }])
  })

  it('sorts findings worst-first, then by id for determinism', async () => {
    const { findings } = await runRepoChecks(makeRepoContext(), [
      emitting('test.b-low', 'low'),
      emitting('test.z-critical', 'critical'),
      emitting('test.a-low', 'low'),
      emitting('test.m-high', 'high'),
    ])
    expect(findings.map((f) => f.checkId)).toEqual([
      'test.z-critical',
      'test.m-high',
      'test.a-low',
      'test.b-low',
    ])
  })

  it('runs a clean repo with zero findings and zero errors', async () => {
    // The false-positive guard: every shallow check on a clean, well-configured
    // repo must stay silent. Adding a check that fires here is a bug in it.
    const ctx = makeRepoContext({
      workflows: [{ path: '.github/workflows/ci.yml', name: 'ci', yaml: 'name: ci\non: [push]\npermissions:\n  contents: read\njobs:\n  build:\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@v4\n' }],
      codeowners: '* @platform\n.github/ @platform\ndb/ @data\n',
      tree: [
        { path: 'README.md', type: 'blob', size: 10 },
        { path: 'SECURITY.md', type: 'blob', size: 10 },
        { path: '.github/workflows/ci.yml', type: 'blob', size: 10 },
      ],
      commits: [
        { sha: 'a', author: 'x', date: '2026-01-01', message: 'init', verified: true },
        { sha: 'b', author: 'y', date: '2026-01-02', message: 'fix', verified: true },
      ],
    })
    const { findings, errors } = await runRepoChecks(ctx)
    expect(errors).toEqual([])
    expect(findings).toEqual([])
  })
})

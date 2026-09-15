/**
 * Test helper: build a synthetic RepoCheckContext with zero network I/O.
 *
 * Every unit test describes a repo as plain data (commits, workflows, branch
 * protection, a tree, …) and gets back the same shape the worker assembles.
 * Defaults describe a clean, well-configured public repo — the false-positive
 * guard. A test for one check overrides only the field that check reads, so the
 * others stay silent.
 */

import type { RepoCheckContext, RepoApiContext, RepoCloneContext, WorkflowFile } from '../src/types.ts'

export interface ApiOverrides {
  commits?: RepoApiContext['commits']
  pulls?: RepoApiContext['pulls']
  workflows?: WorkflowFile[]
  workflowRuns?: RepoApiContext['workflowRuns']
  branchProtection?: RepoApiContext['branchProtection']
  codeowners?: string | null
  dependabotAlerts?: RepoApiContext['dependabotAlerts']
  codeScanningAlerts?: RepoApiContext['codeScanningAlerts']
  securityAndAnalysis?: Partial<RepoApiContext['securityAndAnalysis']>
  tree?: RepoApiContext['tree']
  license?: string | null
  gitignore?: string | null
  clone?: RepoCloneContext
}

export function makeRepoContext(overrides: ApiOverrides = {}): RepoCheckContext {
  // Nullable fields use an explicit undefined check rather than `??`, because a
  // test that passes `license: null` (a present null meaning "absent") must not
  // be swallowed back into the clean default. This is the same null-vs-undefined
  // discipline the site checks' helpers apply to their own overrides.
  return {
    owner: 'acme',
    name: 'web',
    defaultBranch: 'main',
    api: {
      commits: overrides.commits ?? [],
      pulls: overrides.pulls ?? [],
      workflows: overrides.workflows ?? [],
      workflowRuns: overrides.workflowRuns ?? [],
      branchProtection: overrides.branchProtection === undefined ? protectedBranch() : overrides.branchProtection,
      codeowners: overrides.codeowners === undefined ? null : overrides.codeowners,
      dependabotAlerts: overrides.dependabotAlerts ?? [],
      codeScanningAlerts: overrides.codeScanningAlerts ?? [],
      securityAndAnalysis: {
        secretScanning: true,
        pushProtection: true,
        dependabotSecurityUpdates: true,
        ...overrides.securityAndAnalysis,
      },
      tree: overrides.tree ?? [],
      license: overrides.license === undefined ? 'mit' : overrides.license,
      gitignore: overrides.gitignore === undefined ? '.env\n.env.*\n!.env.example\n' : overrides.gitignore,
    },
    clone: overrides.clone,
  }
}

/** A fully-protected default branch — every ci-cd check stays silent. */
export function protectedBranch(): RepoApiContext['branchProtection'] {
  return {
    required_status_checks: { contexts: ['ci'], strict: true },
    required_pull_request_reviews: { required_approving_review_count: 1 },
    allow_force_pushes: { enabled: false },
  }
}

export function workflow(path: string, yaml: string): WorkflowFile {
  return { path, name: path, yaml }
}

/** A minimal workflow with pinned first-party actions and least-privilege perms. */
export const CLEAN_WORKFLOW = `name: ci
on: [push]
permissions:
  contents: read
jobs:
  build:
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
`

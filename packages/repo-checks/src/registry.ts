/**
 * Repo check registry + runner.
 *
 * The direct parallel of @scanlyfix/checks' registry.ts. `allRepoChecks` is the
 * single source of truth for what a repo scan runs — the web app's Inngest job,
 * the scoring coverage and the count test all derive from this list. Adding a
 * check is one import + one array entry; nothing else in the engine changes.
 *
 * Runner rules (copied verbatim in spirit from the site engine):
 *   - Checks run concurrently: they are CPU-trivial over a pre-assembled
 *     context, so wall-clock stays that of the slowest check, not the sum.
 *   - A check that throws or hangs must never kill the scan. Failures are
 *     collected as RepoCheckError, reported alongside findings, and the rest of
 *     the report stays valid.
 *   - Output order is deterministic (severity, then id) so diffs between two
 *     scans of the same repo are meaningful.
 */

import { SEVERITY_ORDER } from '@scanlyfix/checks'
import type { RepoCheck, RepoCheckContext, RepoCheckError, RepoFinding } from './types.ts'

import { gitignoreMissingEnvCheck } from './checks/governance/gitignore.ts'
import { codeownersMissingSensitivePathsCheck, noCodeownersCheck } from './checks/governance/codeowners.ts'
import { noLicenseCheck, noReadmeCheck, noSecurityMdCheck } from './checks/governance/repo-files.ts'
import { forcePushesAllowedCheck, noBranchProtectionCheck, noRequiredReviewsCheck, noRequiredStatusChecksCheck } from './checks/ci-cd/branch-protection.ts'
import { noPushProtectionCheck } from './checks/ci-cd/push-protection.ts'
import { noConcurrencyCheck, workflowMissingTimeoutCheck } from './checks/ci-cd/workflow-hygiene.ts'
import { unverifiedCommitsCheck } from './checks/ci-cd/commit-signing.ts'
import { actionsNotPinnedToShaCheck } from './checks/supply-chain/action-pinning.ts'
import { prTargetInjectionCheck } from './checks/supply-chain/pr-target-injection.ts'
import { permissionsMissingCheck, permissionsWriteAllCheck } from './checks/supply-chain/workflow-permissions.ts'
import { dependabotDisabledCheck } from './checks/supply-chain/dependabot.ts'
import { committedSecretsCheck } from './checks/secrets/committed-secrets.ts'
import { knownVulnerabilitiesCheck } from './checks/dependencies/known-vulnerabilities.ts'

export const allRepoChecks: readonly RepoCheck[] = [
  // governance — repo-responsibility files. Mostly low/info; the gitignore one
  // is high because an open .gitignore is one `git add .` from a leaked secret.
  noCodeownersCheck,
  codeownersMissingSensitivePathsCheck,
  noSecurityMdCheck,
  noLicenseCheck,
  noReadmeCheck,
  gitignoreMissingEnvCheck,
  // ci-cd — the gate that stops a bad commit reaching the default branch, and
  // the workflow hygiene that stops a run becoming a bill or a race.
  noBranchProtectionCheck,
  noRequiredStatusChecksCheck,
  noRequiredReviewsCheck,
  forcePushesAllowedCheck,
  noPushProtectionCheck,
  unverifiedCommitsCheck,
  workflowMissingTimeoutCheck,
  noConcurrencyCheck,
  // supply-chain — trust in third-party code that runs in your name. The PR
  // injection check is critical because it is the one that hands your secrets
  // to a fork attacker.
  prTargetInjectionCheck,
  actionsNotPinnedToShaCheck,
  permissionsWriteAllCheck,
  permissionsMissingCheck,
  dependabotDisabledCheck,
  // deep — read the cloned tree; silent on a shallow scan (no clone).
  committedSecretsCheck,
  knownVulnerabilitiesCheck,
]

export interface RepoRunResult {
  findings: RepoFinding[]
  errors: RepoCheckError[]
}

/** Generous: a repo check reads pre-assembled data and does trivial CPU work. */
const CHECK_TIMEOUT_MS = 10_000

export async function runRepoChecks(
  ctx: RepoCheckContext,
  checks: readonly RepoCheck[] = allRepoChecks,
): Promise<RepoRunResult> {
  const results = await Promise.all(
    checks.map(async (check): Promise<RepoFinding[] | RepoCheckError> => {
      try {
        return await withTimeout(Promise.resolve(check.run(ctx)), check.id)
      } catch (error) {
        return { checkId: check.id, message: error instanceof Error ? error.message : String(error) }
      }
    }),
  )

  const findings: RepoFinding[] = []
  const errors: RepoCheckError[] = []
  for (const result of results) {
    if (Array.isArray(result)) findings.push(...result)
    else errors.push(result)
  }

  const rank = (f: RepoFinding) => SEVERITY_ORDER.indexOf(f.severity)
  findings.sort((a, b) => rank(a) - rank(b) || a.checkId.localeCompare(b.checkId))

  return { findings, errors }
}

async function withTimeout(work: Promise<RepoFinding[]>, checkId: string): Promise<RepoFinding[]> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`repo check timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS)
    timer.unref() // never keep the process alive just to fail a check
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

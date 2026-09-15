/**
 * Dependencies with known vulnerabilities, from osv-scanner over the cloned tree.
 *
 * The deep-scan half of the pair dependabot.ts references: that check says the
 * mechanism that would fix vulns is off, this one names the vulns that are
 * actually present. Reads `clone.osv` and stays silent on a shallow scan, where
 * absence of evidence is not evidence of absence.
 *
 * One finding whose severity is the worst vulnerability present, mirroring how
 * the site engine reports a set of related defects once rather than once each.
 */

import { SEVERITY_ORDER, type Severity } from '@scanlyfix/checks'
import type { RepoCheck, RepoFinding } from '../../types.ts'

const ID = 'dependencies.known-vulnerabilities'

/** osv-scanner's max_severity rating ladder → the shared repo Severity ladder. */
function mapSeverity(rating: string): Severity {
  switch (rating.toUpperCase()) {
    case 'CRITICAL':
      return 'critical'
    case 'HIGH':
      return 'high'
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium'
    case 'LOW':
      return 'low'
    default:
      return 'medium'
  }
}

export const knownVulnerabilitiesCheck: RepoCheck = {
  id: ID,
  category: 'dependencies',
  title: 'Dependencies with known vulnerabilities',

  run(ctx) {
    const vulns = ctx.clone?.osv ?? []
    if (vulns.length === 0) return []

    const severity = vulns
      .map((v) => mapSeverity(v.severity))
      .reduce<Severity>((worst, s) => (SEVERITY_ORDER.indexOf(s) < SEVERITY_ORDER.indexOf(worst) ? s : worst), 'info')

    return [
      {
        checkId: ID,
        category: 'dependencies',
        severity,
        title: `${vulns.length} vulnerable dependenc${vulns.length === 1 ? 'y' : 'ies'}`,
        description:
          'osv-scanner found dependencies with known vulnerabilities. Each advisory is public, so an ' +
          'attacker who can identify the repo already knows what is exploitable; the fix is the same ' +
          'as the exposure — update to a patched version and regenerate the lockfile.',
        evidence: { vulnerabilities: vulns },
        remediation:
          'Update every listed dependency to a fixed version (or the newest available), regenerate the ' +
          'lockfile, and re-run the scan. Prefer the smallest version bump that clears the advisory.',
        fixPrompt:
          'Update the vulnerable dependencies below and regenerate the lockfile:\n\n' +
          vulns
            .map((v) => `- ${v.package}@${v.version} — ${v.vulnId}${v.fixed ? ` (fix: ${v.fixed})` : ''}`)
            .join('\n') +
          '\n\n1. Bump each package to a fixed version (or the latest) in the manifest.\n' +
          '2. Run the package manager install to regenerate the lockfile.\n' +
          '3. Re-run the repo scan to confirm the advisories are gone. If a package has no fixed ' +
          'version yet, look for the maintainer\u2019s mitigation or an alternative dependency.',
      } satisfies RepoFinding,
    ]
  },
}

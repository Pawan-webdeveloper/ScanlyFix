/**
 * Secrets committed to the repository, from gitleaks over the cloned history.
 *
 * The deep-scan half of the pair gitignore.ts references: that check says "the
 * door is open", this one says "something walked through it". Reads the
 * `clone.gitleaks` payload the worker assembles and stays silent on a shallow
 * scan (no clone), where absence of evidence is not evidence of absence.
 *
 * One finding for the whole set of leaks, mirroring the site engine's
 * secrets-in-js check: a report listing forty leaked keys is noise, and the
 * evidence array is where each one is located. Every sample is redacted by the
 * worker before it reaches this check, so the value is safe to store and show.
 */

import type { RepoCheck, RepoFinding } from '../../types.ts'

const ID = 'secrets.committed-secrets'

export const committedSecretsCheck: RepoCheck = {
  id: ID,
  category: 'secrets',
  title: 'Secrets committed to the repository',

  run(ctx) {
    const leaks = ctx.clone?.gitleaks ?? []
    if (leaks.length === 0) return []

    return [
      {
        checkId: ID,
        category: 'secrets',
        severity: 'critical',
        title: `${leaks.length} secret${leaks.length === 1 ? '' : 's'} in the repository`,
        description:
          'gitleaks found credentials or other secrets committed to the repository. Anything ' +
          'committed has already been pushed and copied; removing it from the tree does not un-publish ' +
          'it, so every one of these must be rotated at its issuer, not just deleted.',
        evidence: {
          secrets: leaks.map((l) => ({ file: l.file, line: l.line, rule: l.rule, sample: l.sample })),
        },
        remediation:
          'Rotate every listed secret at its issuer first, then scrub it from git history (or rotate ' +
          'and accept the history if the repo is public and the value is unrecoverable). Move future ' +
          'secrets behind an environment variable or a secret store, never a committed file.',
        fixPrompt:
          'Rotate and remove the committed secrets below, in this order:\n\n' +
          leaks
            .map((l) => `- ${l.file}:${l.line} (${l.rule})`)
            .join('\n') +
          '\n\n1. ROTATE each secret at its issuer first. A key already in git history is compromised; ' +
          'no code change recalls it.\n' +
          '2. Remove the value from the file and move it to an environment variable or a secret store.\n' +
          '3. Scrub it from history (git filter-repo / BFG) if the repo is not already public.\n' +
          '4. Confirm the file is ignored (see the .gitignore check) so the next commit cannot re-add it.',
      } satisfies RepoFinding,
    ]
  },
}

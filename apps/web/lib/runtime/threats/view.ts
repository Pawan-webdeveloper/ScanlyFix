import type { AuthPressure } from '@scanlyfix/db';

/**
 * Deciding when sign-in volume becomes an attack.
 *
 * Server-only: it takes rows straight from the aggregate query. The words the
 * console renders live in ./labels.ts instead, which imports nothing from the
 * database so a client component can use it without dragging the driver into
 * the browser bundle.
 */

// ── Sign-in pressure → a finding, or nothing ───────────────────────────────

/**
 * How many sign-ins from one address stop being traffic and start being an
 * attack.
 *
 * Two thresholds because there are two qualities of evidence. A failure the
 * application itself reported is unambiguous, so five of them is enough to say
 * "password guessing" without hedging. An attempt observed from middleware
 * might have succeeded — that is a shared office address signing in, as easily
 * as an attacker — so it takes a volume no team produces before we will say
 * anything at all, and even then we describe what we saw rather than what we
 * think it means.
 */
export const CONFIRMED_FAILURE_THRESHOLD = 5;
export const UNLABELLED_ATTEMPT_THRESHOLD = 20;

export type BruteForceFinding = {
  sourceIp: string | null;
  attempts: number;
  failures: number;
  /** 'certain' only when the application confirmed the failures. */
  confidence: 'certain' | 'likely';
  headline: string;
  detail: string;
  pattern: string;
  firstSeen: Date;
  lastSeen: Date;
};

function minutesBetween(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));
}

/**
 * Turns per-source sign-in counts into findings, or into nothing at all.
 *
 * Nothing at all is the common and correct outcome. A site with users has
 * sign-ins all day, and a feed that reported them would be worthless.
 */
export function bruteForceFindings(pressure: ReadonlyArray<AuthPressure>): BruteForceFinding[] {
  const findings: BruteForceFinding[] = [];

  for (const row of pressure) {
    const confirmed = row.failures >= CONFIRMED_FAILURE_THRESHOLD;
    const flooding = row.attempts >= UNLABELLED_ATTEMPT_THRESHOLD;
    if (!confirmed && !flooding) continue;

    const where = row.sourceIp ?? 'an address the platform did not report';
    const first = new Date(row.firstSeen);
    const last = new Date(row.lastSeen);
    const minutes = minutesBetween(first, last);

    findings.push({
      sourceIp: row.sourceIp,
      attempts: row.attempts,
      failures: row.failures,
      confidence: confirmed ? 'certain' : 'likely',
      headline: confirmed
        ? `${row.failures} failed sign-ins from ${where}`
        : `${row.attempts} sign-in attempts from ${where}`,
      detail: confirmed
        ? `Your application reported ${row.failures} failed sign-ins from this address over ${minutes} minute${minutes === 1 ? '' : 's'}, out of ${row.attempts} attempts. Nobody mistypes a password that many times.`
        : `${row.attempts} sign-ins were attempted from this address over ${minutes} minute${minutes === 1 ? '' : 's'}. We see the requests but not their outcome, so this could be a shared office address — call reportAuthFailure() in your login handler and we can tell you which.`,
      pattern: row.pattern,
      firstSeen: first,
      lastSeen: last,
    });
  }

  // Worst first: confirmed before inferred, then by volume.
  return findings.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'certain' ? -1 : 1;
    return b.attempts - a.attempts;
  });
}

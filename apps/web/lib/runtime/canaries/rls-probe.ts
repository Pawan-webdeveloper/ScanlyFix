import type { CanaryDetection } from './types';

export type AnonProbeResult = { status: number; rowCount: number | null };

/**
 * What the anon key can do to the decoy table, judged deterministically.
 *
 * The decoy table has row level security on and no policy, so the anon role
 * must see nothing. PostgREST expresses "the policy filtered everything out" as
 * 200 with an empty array, not as 403 — so an empty 200 is the healthy answer
 * and rows in a 200 are the alarm.
 *
 *   200 with rows    anyone on the internet can read this table          ALARM
 *   200 empty        the policy is filtering, which is the point         fine
 *   401 / 403        refused outright                                    fine
 *   0 (network)      we could not ask                                    inconclusive
 */
export function evaluateAnonProbe(result: AnonProbeResult): CanaryDetection | null {
  if (result.status === 200 && result.rowCount !== null && result.rowCount > 0) {
    return {
      kind: 'anon_readable',
      source: 'rls_probe',
      canaryId: null,
      marker: null,
      detail:
        'The decoy table can be read with the public anon key, which ships in your frontend. Row level security is missing or a policy is letting the anon role through — every row this table holds is effectively public.',
    };
  }
  return null;
}

/**
 * The write side of the same question.
 *
 * `restProbeAnonInsert` sends a deliberately invalid row: if the policy refuses
 * it, the write was never going to be allowed; if only a column constraint
 * refuses it, the policy would have let a well-formed row through. Nothing is
 * written either way.
 *
 * A table an anonymous caller can write to is worse than one they can read, and
 * the read probe reports it as protected — so this is not a refinement, it is a
 * blind spot being closed.
 */
export function evaluateAnonWriteProbe(result: { wouldWrite: boolean }): CanaryDetection | null {
  if (!result.wouldWrite) return null;
  return {
    kind: 'anon_readable',
    source: 'rls_probe',
    canaryId: null,
    marker: null,
    detail:
      'The public anon key is allowed to INSERT into the decoy table — only a column constraint stopped the test row, not a security policy. Anyone on the internet can write to this table. No row was created by this check.',
  };
}

export type AnonAuditCounts = { readable: string[]; protectedCount: number; unreachable: number };

/** Audit rollup: table names and anon row counts in, a readable summary out. Names only, never data. */
export function buildAnonAuditReport(
  tables: ReadonlyArray<{ name: string; anonCount: number | null }>,
  exclude: ReadonlySet<string>,
): AnonAuditCounts {
  const readable: string[] = [];
  let protectedCount = 0;
  let unreachable = 0;
  for (const t of tables) {
    if (exclude.has(t.name)) continue;
    if (t.anonCount === null) unreachable++;
    else if (t.anonCount > 0) readable.push(t.name);
    else protectedCount++;
  }
  return { readable, protectedCount, unreachable };
}

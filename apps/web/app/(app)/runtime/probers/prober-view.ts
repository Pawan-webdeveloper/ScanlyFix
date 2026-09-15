/**
 * Pure helper for prober UI — no server-side deps.
 */

/** Label for the "Record baseline" / "Refresh" button. */
export function recordBaselineButtonLabel(hasBaseline: boolean, targetCount: number): string {
  if (targetCount === 0) return 'Seed default routes & probe';
  if (!hasBaseline) return 'Record baseline';
  return 'Refresh baseline';
}

export type RunSummaryLike = {
  checked: number;
  baselinesRecorded: number;
  newFindings: number;
  autoResolved: number;
  errors: number;
  inconclusive?: number;
  suppressedAlerts?: number;
};

/** One-line human summary of a prober run for the controls toast. */
export function describeRunSummary(s: RunSummaryLike): string {
  const parts: string[] = [];
  if (s.baselinesRecorded > 0) parts.push(`recorded ${s.baselinesRecorded} baseline${s.baselinesRecorded === 1 ? '' : 's'}`);
  if (s.checked > 0) parts.push(`probed ${s.checked} target${s.checked === 1 ? '' : 's'}`);
  if (s.newFindings > 0) parts.push(`${s.newFindings} new finding${s.newFindings === 1 ? '' : 's'}`);
  if (s.autoResolved > 0) parts.push(`${s.autoResolved} auto-resolved`);
  if (s.inconclusive) parts.push(`${s.inconclusive} inconclusive`);
  if (s.errors > 0) parts.push(`${s.errors} error${s.errors === 1 ? '' : 's'}`);
  if (s.suppressedAlerts) parts.push(`${s.suppressedAlerts} alert${s.suppressedAlerts === 1 ? '' : 's'} muted (flapping)`);
  if (parts.length === 0) return 'Nothing to probe yet.';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

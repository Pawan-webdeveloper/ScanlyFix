/**
 * Pure aggregation of target rows into the numbers the dashboard tiles show.
 */
export type TargetLike = {
  baselineStatus: number | null;
  lastActualStatus: number | null;
  lastVerdict?: string | null;
  lastCheckedAt?: Date | string | null;
};

export type TargetStats = {
  total: number;
  protected: number;
  open: number;
  inconclusive: number;
  unbaselined: number;
  openFindings: number;
  lastCheckedAt: Date | null;
};

function verdictOf(t: TargetLike): 'protected' | 'open' | 'inconclusive' | 'none' {
  if (t.lastVerdict === 'protected') return 'protected';
  if (t.lastVerdict === 'open' || t.lastVerdict === 'exposed') return 'open';
  if (t.lastVerdict === 'inconclusive') return 'inconclusive';
  if (t.lastActualStatus === null) return 'none';
  // Legacy rows (no stored verdict): a status equal to the baseline means "still as recorded".
  if (t.baselineStatus !== null && t.lastActualStatus === t.baselineStatus) {
    return t.baselineStatus >= 200 && t.baselineStatus < 300 ? 'open' : 'protected';
  }
  return 'inconclusive';
}

export function summarizeTargets(targets: ReadonlyArray<TargetLike>, openFindings: number): TargetStats {
  const stats: TargetStats = {
    total: targets.length,
    protected: 0,
    open: 0,
    inconclusive: 0,
    unbaselined: 0,
    openFindings,
    lastCheckedAt: null,
  };
  for (const t of targets) {
    if (t.baselineStatus === null) stats.unbaselined++;
    const v = verdictOf(t);
    if (v === 'protected') stats.protected++;
    else if (v === 'open') stats.open++;
    else if (v === 'inconclusive') stats.inconclusive++;
    if (t.lastCheckedAt) {
      const d = new Date(t.lastCheckedAt);
      if (!isNaN(d.getTime()) && (!stats.lastCheckedAt || d > stats.lastCheckedAt)) stats.lastCheckedAt = d;
    }
  }
  return stats;
}

export const TARGET_VERDICTS = ['protected', 'open', 'exposed', 'inconclusive', 'baseline_recorded'] as const;
export type TargetVerdictLabel = (typeof TARGET_VERDICTS)[number];

/** Pure: which verdict pill to show for a target's latest check (legacy rows fall back to status comparison). */
export function verdictForTarget(t: TargetLike): TargetVerdictLabel | null {
  if (t.lastVerdict && (TARGET_VERDICTS as readonly string[]).includes(t.lastVerdict)) return t.lastVerdict as TargetVerdictLabel;
  if (t.lastActualStatus === null) return null;
  if (t.baselineStatus !== null && t.lastActualStatus === t.baselineStatus) return 'protected';
  return 'inconclusive';
}

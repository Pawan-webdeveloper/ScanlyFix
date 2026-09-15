/**
 * Deciding whether AI spend has gone wrong — from a live window, in minutes.
 *
 * A single flat threshold cannot do this job. The whole failure mode being
 * watched for is a runaway loop, and a loop is not defined by an absolute
 * number:
 *
 *   A project that normally spends five cents an hour and suddenly projects
 *   three dollars has multiplied its burn rate sixtyfold, and never comes near
 *   a ten-dollar threshold. It is exactly the case this feature exists for, and
 *   a flat threshold misses it entirely.
 *
 *   A project that normally spends fifty dollars an hour is fine, and a flat
 *   threshold pages someone about it every single hour until they turn the
 *   alerts off — after which nothing is watching at all.
 *
 * So the rules are ordered by how much the signal is worth:
 *
 *   1. An explicit ceiling. The developer set a number; it wins.
 *   2. The project's own baseline. A large multiple of normal is a spike
 *      whatever the absolute figure, subject to a floor so that fractions of a
 *      cent do not send email.
 *   3. A flat default, for a project too new to have a baseline.
 *
 * Everything here is pure: same inputs, same verdict, no clock and no database.
 */

/** Default absolute velocity threshold for projects with neither ceiling nor baseline ($10.00 / hour). */
export const DEFAULT_ABSOLUTE_THRESHOLD_USD = 10;
export const DEFAULT_ABSOLUTE_THRESHOLD_MICRO_USD = DEFAULT_ABSOLUTE_THRESHOLD_USD * 1_000_000;

/** Fraction of an explicit ceiling at which the first warning goes out. */
export const DEFAULT_ALERT_PCT_OF_CEILING = 80;

/** Multiple of the project's own normal hourly spend that counts as a spike. */
export const BASELINE_SPIKE_MULTIPLE = 5;
/** Multiple at which a spike stops being a warning. */
export const BASELINE_CRITICAL_MULTIPLE = 20;

/**
 * A spike below this projected rate is not worth an email however large the
 * multiple: going from $0.001/h to $0.02/h is a twentyfold increase and still
 * costs nothing.
 */
export const MIN_SPIKE_MICRO_USD_PER_HOUR = 250_000; // $0.25/hour

/** Why an alert fired. `null` when none did. */
export type SpendAlertReason = 'ceiling' | 'baseline_spike' | 'absolute';
export type SpendAlertSeverity = 'warning' | 'critical';

export type VelocityInput = {
  windowMicroUsd: number;
  windowMinutes: number;
  ceilingMicroUsd: number | null;
  /** Alert threshold (% of ceiling). Default 80. */
  alertAtPctOfCeiling?: number;
  /** The project's own median hourly spend, when it has enough history. */
  baselineMicroUsd?: number | null;
};

export type VelocityVerdict = {
  projectedHourlyMicroUsd: number;
  pctOfCeiling: number | null;
  /** How many times the project's own normal hourly spend this projects to. */
  baselineMultiple: number | null;
  reason: SpendAlertReason | null;
  severity: SpendAlertSeverity | null;
  shouldAlert: boolean;
};

const IDLE: Omit<VelocityVerdict, 'pctOfCeiling'> = {
  projectedHourlyMicroUsd: 0,
  baselineMultiple: null,
  reason: null,
  severity: null,
  shouldAlert: false,
};

/** Extrapolates a short live window to an hourly rate. */
export function projectHourly(windowMicroUsd: number, windowMinutes: number): number {
  if (windowMicroUsd <= 0 || windowMinutes <= 0) return 0;
  return Math.round((windowMicroUsd / windowMinutes) * 60);
}

export function evaluateVelocity(input: VelocityInput): VelocityVerdict {
  const hasCeiling = input.ceilingMicroUsd !== null && input.ceilingMicroUsd > 0;

  if (input.windowMicroUsd <= 0 || input.windowMinutes <= 0) {
    return { ...IDLE, pctOfCeiling: hasCeiling ? 0 : null };
  }

  const projected = projectHourly(input.windowMicroUsd, input.windowMinutes);
  const baseline = input.baselineMicroUsd && input.baselineMicroUsd > 0 ? input.baselineMicroUsd : null;
  const baselineMultiple = baseline ? Math.round((projected / baseline) * 10) / 10 : null;

  // ── 1. An explicit ceiling wins: the developer asked for this number ──────
  if (hasCeiling) {
    const ceiling = input.ceilingMicroUsd as number;
    const pct = Math.round((projected / ceiling) * 100);
    const threshold = input.alertAtPctOfCeiling ?? DEFAULT_ALERT_PCT_OF_CEILING;
    const shouldAlert = pct >= threshold;
    return {
      projectedHourlyMicroUsd: projected,
      pctOfCeiling: pct,
      baselineMultiple,
      reason: shouldAlert ? 'ceiling' : null,
      severity: shouldAlert ? (pct >= 100 ? 'critical' : 'warning') : null,
      shouldAlert,
    };
  }

  // ── 2. The project's own normal, when it has one ─────────────────────────
  if (baseline !== null && baselineMultiple !== null) {
    const isSpike = baselineMultiple >= BASELINE_SPIKE_MULTIPLE && projected >= MIN_SPIKE_MICRO_USD_PER_HOUR;
    if (isSpike) {
      return {
        projectedHourlyMicroUsd: projected,
        pctOfCeiling: null,
        baselineMultiple,
        reason: 'baseline_spike',
        severity: baselineMultiple >= BASELINE_CRITICAL_MULTIPLE ? 'critical' : 'warning',
        shouldAlert: true,
      };
    }
    // No absolute floor is applied on top of a known baseline. Adding one would
    // reintroduce the failure it exists to avoid: a project whose normal is
    // fifty dollars an hour would be paged every hour for behaving normally,
    // and the alerts would be turned off — after which nothing is watching.
    // The developer who wants an absolute limit sets a ceiling; that is what a
    // ceiling is.
    return { projectedHourlyMicroUsd: projected, pctOfCeiling: null, baselineMultiple, reason: null, severity: null, shouldAlert: false };
  }

  // ── 3. Too new to know what normal looks like ────────────────────────────
  const shouldAlert = projected >= DEFAULT_ABSOLUTE_THRESHOLD_MICRO_USD;
  return {
    projectedHourlyMicroUsd: projected,
    pctOfCeiling: null,
    baselineMultiple: null,
    reason: shouldAlert ? 'absolute' : null,
    severity: shouldAlert ? 'warning' : null,
    shouldAlert,
  };
}

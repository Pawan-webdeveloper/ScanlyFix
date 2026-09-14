import { describe, expect, it } from 'vitest';

import {
  BASELINE_CRITICAL_MULTIPLE,
  BASELINE_SPIKE_MULTIPLE,
  DEFAULT_ABSOLUTE_THRESHOLD_MICRO_USD,
  DEFAULT_ALERT_PCT_OF_CEILING,
  evaluateVelocity,
  MIN_SPIKE_MICRO_USD_PER_HOUR,
  projectHourly,
} from '../lib/runtime/ai-spend/velocity.ts';

const usd = (n: number) => n * 1_000_000;

/** Spend over a 15-minute window that projects to the given hourly rate. */
const windowFor = (hourlyUsd: number) => ({ windowMicroUsd: usd(hourlyUsd) / 4, windowMinutes: 15 });

describe('AI spend velocity — projection', () => {
  it('extrapolates a live window to an hourly rate', () => {
    expect(projectHourly(usd(1), 15)).toBe(usd(4));
    expect(projectHourly(usd(2), 60)).toBe(usd(2));
    expect(projectHourly(usd(1), 5)).toBe(usd(12));
  });

  it('never divides by zero or projects from nothing', () => {
    expect(projectHourly(0, 15)).toBe(0);
    expect(projectHourly(usd(1), 0)).toBe(0);
    expect(projectHourly(-5, 15)).toBe(0);
  });

  it('stays quiet on an idle project, and reports 0% only when a ceiling exists', () => {
    expect(evaluateVelocity({ windowMicroUsd: 0, windowMinutes: 15, ceilingMicroUsd: usd(5) })).toMatchObject({
      shouldAlert: false,
      projectedHourlyMicroUsd: 0,
      pctOfCeiling: 0,
      reason: null,
    });
    expect(evaluateVelocity({ windowMicroUsd: 0, windowMinutes: 15, ceilingMicroUsd: null }).pctOfCeiling).toBeNull();
  });
});

describe('AI spend velocity — an explicit ceiling wins', () => {
  it('warns at the configured share of the ceiling and escalates past it', () => {
    expect(DEFAULT_ALERT_PCT_OF_CEILING).toBe(80);

    const warn = evaluateVelocity({ ...windowFor(8), ceilingMicroUsd: usd(10) });
    expect(warn).toMatchObject({ shouldAlert: true, reason: 'ceiling', severity: 'warning', pctOfCeiling: 80 });

    const critical = evaluateVelocity({ ...windowFor(12), ceilingMicroUsd: usd(10) });
    expect(critical).toMatchObject({ shouldAlert: true, reason: 'ceiling', severity: 'critical', pctOfCeiling: 120 });
  });

  it('stays quiet below the threshold', () => {
    expect(evaluateVelocity({ ...windowFor(7.9), ceilingMicroUsd: usd(10) }).shouldAlert).toBe(false);
  });

  it('honours a custom alert percentage', () => {
    expect(evaluateVelocity({ ...windowFor(5), ceilingMicroUsd: usd(10), alertAtPctOfCeiling: 50 }).shouldAlert).toBe(true);
    expect(evaluateVelocity({ ...windowFor(5), ceilingMicroUsd: usd(10), alertAtPctOfCeiling: 90 }).shouldAlert).toBe(false);
  });

  it('prefers the ceiling over the baseline, because the developer chose that number', () => {
    // 20× the baseline, but well under the ceiling the developer set.
    const v = evaluateVelocity({ ...windowFor(2), ceilingMicroUsd: usd(50), baselineMicroUsd: usd(0.1) });
    expect(v.shouldAlert).toBe(false);
    expect(v.reason).toBeNull();
    // The multiple is still reported, so the dashboard can show it.
    expect(v.baselineMultiple).toBe(20);
  });
});

describe('AI spend velocity — a project measured against its own normal', () => {
  it('catches the runaway a flat threshold cannot see', () => {
    // $0.05/h normal, now projecting $3/h: sixtyfold, and nowhere near $10.
    const v = evaluateVelocity({ ...windowFor(3), ceilingMicroUsd: null, baselineMicroUsd: usd(0.05) });
    expect(v.shouldAlert).toBe(true);
    expect(v.reason).toBe('baseline_spike');
    expect(v.severity).toBe('critical');
    expect(v.baselineMultiple).toBe(60);
    // The flat guard would have said nothing at all.
    expect(v.projectedHourlyMicroUsd).toBeLessThan(DEFAULT_ABSOLUTE_THRESHOLD_MICRO_USD);
  });

  it('does not page a project whose normal is simply high', () => {
    // $50/h is this project's normal; projecting $55/h is an ordinary hour.
    const v = evaluateVelocity({ ...windowFor(55), ceilingMicroUsd: null, baselineMicroUsd: usd(50) });
    expect(v.shouldAlert).toBe(false);
    expect(v.baselineMultiple).toBe(1.1);
  });

  it('needs both a large multiple and a rate worth an email', () => {
    // 20× of a fraction of a cent is still a fraction of a cent.
    const tiny = evaluateVelocity({ ...windowFor(0.02), ceilingMicroUsd: null, baselineMicroUsd: usd(0.001) });
    expect(tiny.baselineMultiple).toBe(20);
    expect(tiny.shouldAlert).toBe(false);
    expect(tiny.projectedHourlyMicroUsd).toBeLessThan(MIN_SPIKE_MICRO_USD_PER_HOUR);

    // The same multiple above the floor does alert.
    const real = evaluateVelocity({ ...windowFor(1), ceilingMicroUsd: null, baselineMicroUsd: usd(0.05) });
    expect(real.shouldAlert).toBe(true);
  });

  it('separates a warning-sized spike from a critical one', () => {
    expect(BASELINE_SPIKE_MULTIPLE).toBe(5);
    expect(BASELINE_CRITICAL_MULTIPLE).toBe(20);

    const warn = evaluateVelocity({ ...windowFor(3), ceilingMicroUsd: null, baselineMicroUsd: usd(0.5) });
    expect(warn).toMatchObject({ shouldAlert: true, severity: 'warning', baselineMultiple: 6 });

    const critical = evaluateVelocity({ ...windowFor(15), ceilingMicroUsd: null, baselineMicroUsd: usd(0.5) });
    expect(critical).toMatchObject({ shouldAlert: true, severity: 'critical', baselineMultiple: 30 });
  });

  it('just below the spike multiple stays quiet', () => {
    const v = evaluateVelocity({ ...windowFor(2), ceilingMicroUsd: null, baselineMicroUsd: usd(0.5) });
    expect(v.baselineMultiple).toBe(4);
    expect(v.shouldAlert).toBe(false);
  });

  it('applies no absolute floor once a baseline exists — that is what a ceiling is for', () => {
    // 4× normal is under the spike multiple, so it stays quiet even at $40/h.
    // Re-adding a flat floor here would page a busy project every hour, which
    // is the failure the baseline comparison exists to avoid.
    const quiet = evaluateVelocity({ ...windowFor(40), ceilingMicroUsd: null, baselineMicroUsd: usd(10) });
    expect(quiet.shouldAlert).toBe(false);
    expect(quiet.baselineMultiple).toBe(4);

    // A developer who wants a hard number sets one, and then it wins.
    const withCeiling = evaluateVelocity({ ...windowFor(40), ceilingMicroUsd: usd(20), baselineMicroUsd: usd(10) });
    expect(withCeiling).toMatchObject({ shouldAlert: true, reason: 'ceiling', severity: 'critical' });
  });
});

describe('AI spend velocity — a project too new to have a normal', () => {
  it('falls back to the flat guard', () => {
    expect(evaluateVelocity({ ...windowFor(12), ceilingMicroUsd: null, baselineMicroUsd: null })).toMatchObject({
      shouldAlert: true,
      reason: 'absolute',
      severity: 'warning',
      baselineMultiple: null,
    });
    expect(evaluateVelocity({ ...windowFor(3), ceilingMicroUsd: null, baselineMicroUsd: null }).shouldAlert).toBe(false);
  });

  it('treats a zero or negative baseline as no baseline at all', () => {
    for (const baseline of [0, -1, null, undefined]) {
      const v = evaluateVelocity({ ...windowFor(3), ceilingMicroUsd: null, baselineMicroUsd: baseline });
      expect(v.baselineMultiple, String(baseline)).toBeNull();
      expect(v.shouldAlert, String(baseline)).toBe(false);
    }
  });

  it('treats a zero ceiling as no ceiling', () => {
    const v = evaluateVelocity({ ...windowFor(12), ceilingMicroUsd: 0, baselineMicroUsd: null });
    expect(v.pctOfCeiling).toBeNull();
    expect(v.reason).toBe('absolute');
  });
});

import { describe, expect, it } from 'vitest';

import {
  MAX_CEILING_USD,
  MICRO_PER_USD,
  MIN_CEILING_USD,
  suggestedCeilingUsd,
  validateCeilingUsd,
} from '../lib/runtime/ai-spend/ceiling.ts';

describe('spend ceiling validation', () => {
  it('accepts a value inside the bounds and converts it to the stored unit', () => {
    expect(validateCeilingUsd(5)).toEqual({ ok: true, microUsd: 5 * MICRO_PER_USD });
    expect(validateCeilingUsd(MIN_CEILING_USD)).toEqual({ ok: true, microUsd: MIN_CEILING_USD * MICRO_PER_USD });
    expect(validateCeilingUsd(MAX_CEILING_USD)).toEqual({ ok: true, microUsd: MAX_CEILING_USD * MICRO_PER_USD });
  });

  it('rounds to whole micro-USD rather than storing a fraction', () => {
    const result = validateCeilingUsd(12.3456789);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Number.isInteger(result.microUsd)).toBe(true);
  });

  it('rejects anything outside the bounds', () => {
    for (const value of [0, -5, MIN_CEILING_USD - 0.01, MAX_CEILING_USD + 1]) {
      expect(validateCeilingUsd(value).ok, String(value)).toBe(false);
    }
  });

  it('rejects values that are not numbers at all', () => {
    // The action receives this from a form field, so the hostile cases are real.
    for (const value of [NaN, Infinity, -Infinity, 'abc', null, undefined, {}, []]) {
      expect(validateCeilingUsd(value).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it('accepts a numeric string, because that is what a form field sends', () => {
    expect(validateCeilingUsd('7.5')).toEqual({ ok: true, microUsd: 7_500_000 });
  });

  it('names the bounds in the error, so the message is actionable', () => {
    const result = validateCeilingUsd(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(MIN_CEILING_USD));
      expect(result.error).toContain('10,000');
    }
  });
});

describe('suggested ceiling', () => {
  it('sits a little above the project’s own normal', () => {
    expect(suggestedCeilingUsd(1_000_000)).toBe(3); // $1/h normal → $3/h
    expect(suggestedCeilingUsd(2_500_000)).toBe(8); // $2.50/h normal → $7.50, rounded up
  });

  it('never suggests a value the input would reject', () => {
    for (const baseline of [null, 0, -1, 1, 100, 1_000_000_000]) {
      const suggested = suggestedCeilingUsd(baseline);
      expect(suggested, String(baseline)).toBeGreaterThanOrEqual(MIN_CEILING_USD);
      expect(validateCeilingUsd(suggested).ok, String(baseline)).toBe(true);
    }
  });

  it('falls back to a sensible figure with no baseline', () => {
    expect(suggestedCeilingUsd(null)).toBe(5);
  });
});

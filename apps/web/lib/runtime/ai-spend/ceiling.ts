/**
 * The hourly spend ceiling, and the bounds it has to stay inside.
 *
 * Pure, and separate from the server action, because a `'use server'` module
 * may only export async functions — a constant exported from one is a build
 * error, and the UI needs these numbers to render the input's own limits.
 */

export const MICRO_PER_USD = 1_000_000;

/**
 * Lower bound. Below about fifty cents an hour the ceiling starts refusing
 * ordinary single calls on a frontier model, which reads as the integration
 * being broken rather than as a budget being enforced.
 */
export const MIN_CEILING_USD = 0.5;

/** Upper bound. Past this the ceiling is not protecting anyone from anything. */
export const MAX_CEILING_USD = 10_000;

export type CeilingValidation = { ok: true; microUsd: number } | { ok: false; error: string };

/** Validates a user-entered ceiling and converts it to the stored unit. */
export function validateCeilingUsd(value: unknown): CeilingValidation {
  const usd = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(usd)) return { ok: false, error: 'ceiling must be a number' };
  if (usd < MIN_CEILING_USD || usd > MAX_CEILING_USD) {
    return { ok: false, error: `ceiling must be between $${MIN_CEILING_USD} and $${MAX_CEILING_USD.toLocaleString()}` };
  }
  return { ok: true, microUsd: Math.round(usd * MICRO_PER_USD) };
}

/** A ceiling a little above the project's own normal is the useful default. */
export function suggestedCeilingUsd(baselineMicroUsd: number | null): number {
  if (!baselineMicroUsd || baselineMicroUsd <= 0) return 5;
  return Math.max(MIN_CEILING_USD, Math.ceil((baselineMicroUsd * 3) / MICRO_PER_USD));
}

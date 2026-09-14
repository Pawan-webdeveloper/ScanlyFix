/** PURE — DB ka kahin role nahi. UI + email dono yahi helpers use karein. */

export type CallRow = {
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number | null;
  costMicroUsd: number | null;
  userHash: string | null;
  source?: string | null;
  status?: string | null;
  errorKind?: string | null;
  createdAt: Date;
};

export function formatUsd(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined) return '—';
  if (microUsd === 0) return '$0.00';
  return `$${(microUsd / 1e6).toFixed(microUsd < 10_000 ? 4 : 2)}`; // <$0.01 → 4 decimals
}

/** Hour-ki-abhi-tak-ki rate se end-of-hour projection (0-div guard). */
export function projectEndOfHourMicroUsd(currentHourMicroUsd: number, now: Date = new Date()): number {
  const minutesElapsed = now.getUTCMinutes() + now.getUTCSeconds() / 60;
  if (minutesElapsed < 1) return currentHourMicroUsd;
  return Math.round((currentHourMicroUsd / minutesElapsed) * 60);
}

/**
 * Did this call fail?
 *
 * `status` is NULL on success, because SDK builds that predate error reporting
 * only ever sent successes — an absent value must read as "fine", never as
 * "unknown, assume broken".
 */
export function isFailedCall(call: Pick<CallRow, 'status'>): boolean {
  return call.status === 'error';
}

/** Sample rows are seeded for demonstration and must never move a real number. */
export function isSampleCall(call: Pick<CallRow, 'source'>): boolean {
  return call.source === 'sample';
}

import type { SyncResult } from './sync.ts';

/**
 * One sentence describing what a sync run did, including what it deliberately
 * left out. "Synced 3 routes" hides the two POST endpoints nothing will ever
 * check; saying so is the point of the message.
 */
export function describeSyncResult(result: SyncResult): string {
  const parts: string[] = [];
  if (result.synced > 0) {
    parts.push(`synced ${result.synced} route${result.synced === 1 ? '' : 's'} to the nightly prober`);
  }
  if (result.skippedUnverifiable > 0) {
    parts.push(
      `${result.skippedUnverifiable} need${result.skippedUnverifiable === 1 ? 's' : ''} a manual check (the prober only sends GET)`,
    );
  }
  if (result.skippedStale > 0) {
    parts.push(`${result.skippedStale} skipped as stale`);
  }
  if (parts.length === 0) {
    return result.candidates === 0
      ? 'No routes observed yet — install the SDK and send some traffic.'
      : 'Nothing to sync: no logged-in-only GET routes were observed.';
  }
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

import { createHash } from 'node:crypto';

import { MAX_LOG_ROWS_PER_CHECK, type CanaryDetection, type IntegrityVerdict } from './types';

/**
 * Tamper evidence, from two independent sources.
 *
 * STATE — a hash of each decoy row's payload, compared against the last check.
 * Catches a row that is currently missing or currently different.
 *
 * HISTORY — the trigger log. The setup SQL puts an AFTER UPDATE OR DELETE
 * trigger on the decoy table that records the operation, the marker and the
 * timestamp on every touch. Nothing legitimate ever writes to those rows, so a
 * log row is not a hint that something happened: it IS the something.
 *
 * History is the stronger of the two and used to be thrown away. The engine
 * read the log only to count its rows, and treated growth as normal — there is
 * even a test asserting that a larger count raises no detection. That left the
 * obvious evasion wide open: change a decoy row, then change it back. The state
 * comparison sees nothing, while the log holds two rows naming the operation and
 * the minute it happened. The same is true of deleting a row and re-inserting an
 * identical one.
 *
 * So both are evaluated, and the log wins where they disagree.
 */

/**
 * Stable hash of a payload.
 *
 * Object keys are sorted before serialising. `JSON.stringify` preserves
 * insertion order, and while Postgres normalises jsonb key order on storage, a
 * hash that depends on key order at all is a false positive waiting for the day
 * something upstream reorders them — and a false "your database was breached"
 * email is the worst output this product can produce.
 */
export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export type LiveCanaryRow = { marker: string; payload: unknown };

/** One row the database trigger wrote when a decoy row was touched. */
export type TriggerLogRow = {
  id: number;
  canary_marker: string | null;
  /** The trigger records tg_op verbatim: 'UPDATE' or 'DELETE'. */
  action: string;
  acted_at: string;
};

export type SnapshotMirror = {
  payloadHashes: Record<string, string>;
  logRowCount: number;
  /**
   * Highest trigger-log id already accounted for. Rows above it are new
   * evidence; rows at or below it have been reported.
   *
   * Optional because snapshots taken before the log was read have no watermark.
   * Those are baselined on the next check rather than replayed — reporting a
   * project's entire trigger history as fresh intrusions on upgrade day would
   * be a false positive at the worst possible scale.
   */
  lastLogId?: number;
  takenAt: string;
};

export type IntegrityInput = {
  snapshot: SnapshotMirror | null;
  /** null = REST unreachable, which is handled by the caller and never judged here. */
  liveRows: LiveCanaryRow[] | null;
  liveLogCount: number | null;
  /** Trigger-log rows above the watermark, oldest first. */
  newLogRows?: TriggerLogRow[] | null;
  /**
   * Highest id currently in the trigger log, or null when it could not be read.
   *
   * Used only to tell a deletion apart from a table that was recreated, which a
   * row count alone cannot do.
   */
  liveMaxLogId?: number | null;
  /**
   * Markers that must exist, from the canaries table rather than from the
   * snapshot.
   *
   * The snapshot is a derived mirror. Using it as the roster of what should be
   * present makes a disappearance self-healing in the wrong direction: once a
   * marker drops out of `payloadHashes`, nothing remembers it was ever supposed
   * to be there, and it can never be reported missing again.
   */
  expectedMarkers?: ReadonlyArray<string> | null;
  /**
   * The self-test row, which this system rewrites on every run to prove the
   * trigger still fires. Its changes are ours, so it is excluded from both the
   * payload comparison and the log detections.
   */
  selfTestMarker?: string | null;
};

export type IntegrityResult = {
  verdicts: Record<string, IntegrityVerdict>;
  detections: CanaryDetection[];
  newSnapshot: SnapshotMirror;
};

function maxLogId(rows: ReadonlyArray<TriggerLogRow>, fallback: number): number {
  return rows.reduce((max, r) => (Number.isFinite(r.id) && r.id > max ? r.id : max), fallback);
}

function hashesOf(rows: ReadonlyArray<LiveCanaryRow>, skipMarker?: string | null): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const r of rows) {
    if (skipMarker && r.marker === skipMarker) continue;
    hashes[r.marker] = sha256Canonical(r.payload);
  }
  return hashes;
}

/**
 * The trigger records `tg_op` verbatim. An unrecognised value is treated as a
 * modification rather than dropped: a write we cannot name is still a write.
 */
function kindForAction(action: string): 'modified' | 'deleted' | 'row_added' {
  const op = action.trim().toUpperCase();
  if (op === 'DELETE') return 'deleted';
  if (op === 'INSERT') return 'row_added';
  return 'modified';
}

function describeLogRow(row: TriggerLogRow): string {
  const kind = kindForAction(row.action);
  const marker = row.canary_marker ?? 'an unnamed decoy row';
  if (kind === 'row_added') {
    return `A row (${marker}) was inserted into the decoy table at ${row.acted_at}. Only the ScanlyFix setup script ever inserts into this table, and it disarms the trigger while it does.`;
  }
  const verb = kind === 'deleted' ? 'deleted' : 'modified';
  return `Decoy row ${marker} was ${verb} at ${row.acted_at} (database trigger recorded ${row.action.toUpperCase()}). Nothing in your application writes to these rows.`;
}

export function evaluateIntegrity(input: IntegrityInput): IntegrityResult {
  const detections: CanaryDetection[] = [];
  const verdicts: Record<string, IntegrityVerdict> = {};
  const liveRows = input.liveRows ?? [];
  const logRows = input.newLogRows ?? [];

  // ── The very first check has nothing to compare against ──────────────────
  if (!input.snapshot) {
    return {
      verdicts,
      detections,
      newSnapshot: {
        payloadHashes: hashesOf(liveRows, input.selfTestMarker),
        logRowCount: input.liveLogCount ?? 0,
        lastLogId: maxLogId(logRows, 0),
        takenAt: new Date().toISOString(),
      },
    };
  }

  const snapshot = input.snapshot;

  /**
   * Whether the log half of the comparison can run.
   *
   * Only the LOG is baselined when a snapshot predates the watermark. Skipping
   * the payload comparison as well — which an earlier version of this function
   * did, by treating a missing watermark as "no snapshot at all" — threw away a
   * whole night of state detection, and worse, rewrote `payloadHashes` from
   * whatever was live at the time. A row an intruder had already modified would
   * have become the new baseline and never been reported.
   */
  const logWatermarkKnown = snapshot.lastLogId !== undefined;
  const watermark: number = snapshot.lastLogId ?? 0;
  const liveByMarker = new Map(liveRows.map((r) => [r.marker, r]));

  // ── HISTORY: every new trigger-log row is an intrusion, full stop ────────
  // Except the self-test row, whose entries this system wrote on purpose.
  const intruderLogRows = logWatermarkKnown
    ? logRows.filter((r) => !input.selfTestMarker || r.canary_marker !== input.selfTestMarker)
    : [];
  const reportable = intruderLogRows.slice(0, MAX_LOG_ROWS_PER_CHECK);
  for (const row of reportable) {
    detections.push({
      kind: kindForAction(row.action),
      source: 'trigger_log',
      canaryId: null,
      marker: row.canary_marker,
      occurredAt: row.acted_at,
      detail: describeLogRow(row),
    });
  }
  if (intruderLogRows.length > reportable.length) {
    // Never drop the overflow silently: the count is itself the story.
    detections.push({
      kind: 'modified',
      source: 'trigger_log',
      canaryId: null,
      marker: null,
      occurredAt: reportable.at(-1)?.acted_at ?? null,
      detail: `${intruderLogRows.length - reportable.length} further decoy-row writes were recorded in the same period and are not listed individually.`,
    });
  }

  // ── STATE: what the rows look like right now ─────────────────────────────
  // A marker already named by a log row this run is skipped: the log entry says
  // the same thing with a timestamp attached, and two events for one touch is
  // noise in a product that promises there is nothing to triage.
  const markersFromLog = new Set(reportable.map((r) => r.canary_marker).filter((m): m is string => Boolean(m)));

  const roster =
    input.expectedMarkers && input.expectedMarkers.length > 0
      ? [...new Set([...input.expectedMarkers, ...Object.keys(snapshot.payloadHashes)])]
      : Object.keys(snapshot.payloadHashes);

  for (const marker of roster) {
    if (input.selfTestMarker && marker === input.selfTestMarker) continue;
    const expectedHash = snapshot.payloadHashes[marker];
    const live = liveByMarker.get(marker);
    if (!live) {
      verdicts[marker] = 'missing';
      if (!markersFromLog.has(marker)) {
        detections.push({
          kind: 'deleted',
          source: 'integrity',
          canaryId: null,
          marker,
          detail: `Decoy row ${marker} is gone from the table. Nothing in your application deletes these rows.`,
        });
      }
    } else if (expectedHash === undefined) {
      // Present, but never baselined — record it and compare from next run.
      verdicts[marker] = 'ok';
    } else if (sha256Canonical(live.payload) !== expectedHash) {
      verdicts[marker] = 'modified';
      if (!markersFromLog.has(marker)) {
        detections.push({
          kind: 'modified',
          source: 'integrity',
          canaryId: null,
          marker,
          detail: `Decoy row ${marker} holds different data than at the last check. Nothing in your application writes to these rows.`,
        });
      }
    } else {
      verdicts[marker] = 'ok';
    }
  }

  // ── The log itself being cut down is its own kind of evidence ────────────
  //
  // It is not proof of a cover-up on its own, and saying so would be the one
  // false accusation this product cannot take back: a point-in-time restore
  // lowers the count exactly the same way. The identity sequence is the
  // corroboration — it only ever moves forward, so a highest id that is now
  // BELOW one we have already seen means the table itself was replaced, while a
  // sequence that kept climbing means rows were removed from underneath it.
  if (input.liveLogCount !== null && input.liveLogCount < snapshot.logRowCount) {
    const removed = snapshot.logRowCount - input.liveLogCount;
    const rebuilt = logWatermarkKnown && input.liveMaxLogId !== null && input.liveMaxLogId !== undefined && input.liveMaxLogId < watermark;
    detections.push({
      kind: 'log_wiped',
      source: 'integrity',
      canaryId: null,
      marker: null,
      detail: rebuilt
        ? `The decoy trigger log shrank from ${snapshot.logRowCount} to ${input.liveLogCount} rows, and its highest entry id fell from ${watermark} to ${input.liveMaxLogId}. Ids are never reused, so the table was dropped and recreated, truncated, or restored from a backup. If none of those was you, the evidence trail has been destroyed.`
        : `The decoy trigger log shrank from ${snapshot.logRowCount} to ${input.liveLogCount} rows — ${removed} entr${removed === 1 ? 'y is' : 'ies are'} gone while the id sequence kept climbing, which means rows were deleted from it. Entries are only ever appended, so either a restore ran, or someone removed the record of what they did.`,
    });
  }

  return {
    verdicts,
    detections,
    newSnapshot: {
      payloadHashes: hashesOf(liveRows, input.selfTestMarker),
      logRowCount: input.liveLogCount ?? snapshot.logRowCount,
      lastLogId: maxLogId(logRows, watermark),
      takenAt: new Date().toISOString(),
    },
  };
}

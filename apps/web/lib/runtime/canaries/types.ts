export type CanaryEventKind =
  | 'modified'
  | 'deleted'
  /** A row appeared in the decoy table that our setup script did not plant. */
  | 'row_added'
  | 'anon_readable'
  | 'log_wiped'
  | 'honeytoken_hit'
  | 'table_missing'
  | 'watch_disabled'
  | 'unreachable';

export type CanaryEventSource = 'trigger_log' | 'integrity' | 'rls_probe' | 'honeytoken' | 'verify';

/** Every canary event is critical — the zero-triage philosophy. */
export type CanaryDetection = {
  kind: CanaryEventKind;
  source: CanaryEventSource;
  canaryId: string | null;
  /**
   * The decoy row this concerns, when it concerns one.
   *
   * Carried as its own field rather than parsed back out of `detail`. Linking a
   * detection to its canary row used to work by testing whether the prose
   * detail happened to start with the marker, which broke silently whenever the
   * wording changed and left `canaryId` null — and `canaryId` is what the
   * honeytoken rate limiter and the dashboard key on.
   */
  marker?: string | null;
  /** When the event actually occurred, when the database can tell us. */
  occurredAt?: string | null;
  detail: string;
};

export type IntegrityVerdict = 'ok' | 'modified' | 'missing' | 'unreachable';

export const CANARY_ROW_COUNT = 3;
export const CANARY_TABLE = 'scanlyfix_canaries';
export const CANARY_LOG_TABLE = 'scanlyfix_canary_log';
export const MAX_AUDIT_TABLES = 30;

/**
 * Label of the decoy row this system rewrites on every check to prove the
 * detection chain still works. It is ours, so its changes are never reported.
 */
export const SELFTEST_LABEL = 'SELFTEST';

/** `kind` stored for that row, so it can be told apart from real decoys. */
export const SELFTEST_KIND = 'selftest';

/**
 * Trigger-log rows read per check.
 *
 * One page is enough for a report: past this, the point is made and the rest is
 * summarised rather than inserted row by row. An intruder scripting thousands of
 * writes must not be able to turn our own events table into the payload.
 */
export const MAX_LOG_ROWS_PER_CHECK = 25;

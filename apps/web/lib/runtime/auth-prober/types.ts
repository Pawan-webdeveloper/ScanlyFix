export type TargetSource = 'default' | 'guard' | 'manual';
export type FindingSeverity = 'critical' | 'high';

/** v1: sirf logged-out probe. 'anon_key' variant ka hook ready hai
 *  (jaisa "public key from your browser bundle") — Phase 2 me. */
export type ProbeVariant = 'logged_out';

export type ProbeOutcome =
  | { ok: true; status: number }
  | { ok: false; error: string };

/** Har target ka runtime verdict — discriminated union, exhaustive switch possible. */
export type TargetVerdict =
  | { verdict: 'baseline_recorded'; status: number }
  | { verdict: 'protected'; status: number }
  | { verdict: 'open'; status: number; severity: FindingSeverity }
  | { verdict: 'inconclusive'; status: number }
  | { verdict: 'error'; error: string };

export type ProberRunSummary = {
  projectId: string;
  ranAt: string;
  baselinesRecorded: number;
  checked: number;
  newFindings: number;
  autoResolved: number;
  stillOpen: number;
  errors: number;
};

export const PROBE_USER_AGENT = 'ScanlyFixAuthProber/1.0 (+https://scanlyfix.com/bot)';
export const PROBE_TIMEOUT_MS = 10_000;
export const MAX_TARGETS_PER_PROJECT = 50;
export const PROBE_PARALLELISM = 5;
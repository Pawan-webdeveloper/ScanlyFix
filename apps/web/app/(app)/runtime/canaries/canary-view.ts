/**
 * Everything the canary console needs to turn stored enum values into something
 * a person can act on, kept out of the component so it can be unit-tested.
 *
 * The console used to render `status`, `last_integrity` and `kind` straight from
 * the database, so customers read "pending_script" and "anon_readable" with no
 * legend and no next step. These maps are the legend, and each entry carries the
 * one thing the raw value never did: what to do about it.
 */

import { SELFTEST_KIND } from '@/lib/runtime/canaries/types';

export type Tone = 'ok' | 'warn' | 'critical' | 'neutral';

export type CanaryRow = {
  marker: string;
  /** 'vault' for a real decoy, 'selftest' for the row rewritten on every check. */
  kind: string;
  status: string;
  integrity: string | null;
  lastCheckedAt: string | null;
};

export type CanaryEventRow = {
  id: string;
  kind: string;
  detail: string;
  source: string;
  detectedAt: string;
  acknowledgedAt: string | null;
};

export type AnonAuditResult = {
  readable: string[];
  protectedCount: number;
  unreachable: number;
  skipped: number;
  totalTables: number;
};

export type Legend = {
  label: string;
  tone: Tone;
  /** Plain-language meaning, shown as a tooltip and in the legend row. */
  meaning: string;
};

export const BADGE_CLASS: Record<Tone, string> = {
  ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  critical: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  neutral: 'bg-c-soft text-c-muted',
};

export const PANEL_CLASS: Record<Tone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/5',
  warn: 'border-amber-500/30 bg-amber-500/5',
  critical: 'border-rose-500/40 bg-rose-500/5',
  neutral: 'border-c-line bg-c-card',
};

export const TEXT_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  critical: 'text-rose-600 dark:text-rose-400',
  neutral: 'text-c-muted',
};

const UNKNOWN: Legend = {
  label: 'Unknown',
  tone: 'neutral',
  meaning: 'This value was recorded by a newer version of the checker than this page knows about.',
};

/** Lifecycle of one decoy row, as stored in `runtime_canaries.status`. */
const STATUS: Record<string, Legend> = {
  planted: {
    label: 'Watching',
    tone: 'ok',
    meaning: 'The decoy is live in your database and matched its baseline on the last check.',
  },
  compromised: {
    label: 'Touched',
    tone: 'critical',
    meaning: 'This row was changed or removed by something. Nothing in your app should ever touch it.',
  },
  pending_script: {
    label: 'Awaiting SQL',
    tone: 'warn',
    meaning: 'Registered here, but the setup SQL has not been run in Supabase yet, so nothing is being watched.',
  },
  retired: {
    label: 'Retired',
    tone: 'neutral',
    meaning: 'Replaced by a newer set of decoys. Kept only so past events still make sense.',
  },
};

/** Result of the last comparison, as stored in `runtime_canaries.last_integrity`. */
const INTEGRITY: Record<string, Legend> = {
  ok: { label: 'Intact', tone: 'ok', meaning: 'The row is byte-for-byte what we planted.' },
  modified: { label: 'Modified', tone: 'critical', meaning: 'The row is still there, but its contents changed.' },
  missing: { label: 'Missing', tone: 'critical', meaning: 'The row is gone from the table.' },
  unreachable: {
    label: 'Not verified',
    tone: 'warn',
    meaning: 'Supabase could not be reached on the last run, so this row was not checked at all.',
  },
};

/** Event kinds, as stored in `runtime_canary_events.kind`. */
const EVENT: Record<string, Legend> = {
  modified: {
    label: 'Decoy row modified',
    tone: 'critical',
    meaning: 'Something rewrote a row that no code of yours reads or writes.',
  },
  deleted: {
    label: 'Decoy row deleted',
    tone: 'critical',
    meaning: 'A row we planted was removed — often an attempt to clean up after a wider write.',
  },
  row_added: {
    label: 'Row added to the decoy table',
    tone: 'critical',
    meaning: 'Something inserted a row into a table only the setup script ever writes to.',
  },
  honeytoken_hit: {
    label: 'Honeytoken opened',
    tone: 'critical',
    meaning: 'A URL that only exists inside a decoy row was requested, so the decoy data left your database.',
  },
  log_wiped: {
    label: 'Trigger log shrank',
    tone: 'critical',
    meaning: 'Rows disappeared from the tamper log — evidence being cleared, or a restore from backup.',
  },
  anon_readable: {
    label: 'Public access to the decoy table',
    tone: 'critical',
    meaning: 'The anonymous key could reach a table only your server should reach. RLS is not doing its job.',
  },
  table_missing: {
    label: 'Decoy table is gone',
    tone: 'critical',
    meaning: 'The table itself no longer exists, so nothing is being watched.',
  },
  watch_disabled: {
    label: 'Detection is not armed',
    tone: 'warn',
    meaning: 'The self-test could not confirm the chain works. An intrusion might not be reported until this is fixed.',
  },
  unreachable: {
    label: 'Database could not be reached',
    tone: 'warn',
    meaning: 'The check ran but Supabase did not answer, so nothing was verified.',
  },
};

/**
 * Kinds that mean someone was inside, as opposed to kinds that mean we cannot
 * currently tell. The distinction drives the headline: a customer must never
 * read "intrusion detected" when the truth is "we could not look".
 */
const INTRUSION_KINDS: ReadonlySet<string> = new Set([
  'modified',
  'deleted',
  'row_added',
  'honeytoken_hit',
  'log_wiped',
  'anon_readable',
]);

/**
 * Kinds that mean the detector may not be running. These are NOT intrusions —
 * reporting them as one would be crying wolf — but they must still outrank a
 * green banner, because they are the reason silence cannot be trusted.
 */
const BLIND_KINDS: ReadonlySet<string> = new Set(['watch_disabled', 'unreachable', 'table_missing']);

export const statusLegend = (value: string): Legend => STATUS[value] ?? UNKNOWN;
export const integrityLegend = (value: string | null): Legend | null => (value ? (INTEGRITY[value] ?? UNKNOWN) : null);
export const eventLegend = (value: string): Legend => EVENT[value] ?? { ...UNKNOWN, label: value };
export const isIntrusion = (kind: string): boolean => INTRUSION_KINDS.has(kind);

/** The legend rows rendered under the decoy table, so no badge is ever unexplained. */
export const STATUS_LEGEND_ROWS: ReadonlyArray<Legend> = [
  STATUS.planted,
  STATUS.compromised,
  STATUS.pending_script,
].filter((x): x is Legend => x !== undefined);

/**
 * Human label for one decoy.
 *
 * Markers look like `CANARY::<project>::<plant>::<label>`. The full token is
 * what you would search for in Supabase, so it is still shown — but the trailing
 * label is what tells two decoys apart at a glance.
 */
export function decoyLabel(marker: string): string {
  const parts = marker.split('::');
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last && last.length > 0 ? `Decoy ${last}` : marker;
}

/** Where the project is in the setup → watching lifecycle. */
export type CanaryStage = 'disconnected' | 'needs_script' | 'awaiting_sql' | 'live';

export type DerivedState = {
  decoys: CanaryRow[];
  selfTest: CanaryRow | null;
  stage: CanaryStage;
  compromised: CanaryRow[];
  /** Newest `lastCheckedAt` across the decoys, or null if none was ever checked. */
  lastVerifiedAt: string | null;
};

/**
 * The console's whole idea of where a project stands.
 *
 * This replaces a single `planted` boolean the page computed as "some canary has
 * status planted". On a full compromise every row flips to `compromised`, so it
 * went false — which hid every recovery control and pushed the page back into
 * onboarding at the exact moment the customer needed to re-plant. Pure, and
 * therefore testable, for that reason.
 */
export function deriveState(canaries: ReadonlyArray<CanaryRow>, connected: boolean): DerivedState {
  const decoys = canaries.filter((c) => c.kind !== SELFTEST_KIND);
  const selfTest = canaries.find((c) => c.kind === SELFTEST_KIND) ?? null;
  const live = decoys.filter((c) => c.status === 'planted' || c.status === 'compromised');

  const checked = decoys
    .map((c) => c.lastCheckedAt)
    .filter((t): t is string => t !== null)
    .sort();

  return {
    decoys,
    selfTest,
    stage: !connected ? 'disconnected' : live.length > 0 ? 'live' : decoys.length > 0 ? 'awaiting_sql' : 'needs_script',
    compromised: decoys.filter((c) => c.status === 'compromised'),
    lastVerifiedAt: checked.length > 0 ? (checked[checked.length - 1] ?? null) : null,
  };
}

export type Banner = { tone: Tone; title: string; body: string };

/**
 * The one line at the top that has to be right.
 *
 * "All quiet" and "we have not been able to look" are different sentences, and
 * conflating them is the failure mode this entire feature exists to prevent — so
 * a run that could not verify anything never renders as green.
 */
export function deriveBanner(state: DerivedState, unreviewed: ReadonlyArray<CanaryEventRow>): Banner {
  if (state.stage === 'disconnected') {
    return {
      tone: 'neutral',
      title: 'Not connected yet',
      body: 'Connect your Supabase database below to plant decoy rows.',
    };
  }
  if (state.stage === 'needs_script') {
    return {
      tone: 'warn',
      title: 'No decoys planted',
      body: 'Generate the setup SQL and run it in Supabase. Until then nothing is being watched.',
    };
  }
  if (state.stage === 'awaiting_sql') {
    return {
      tone: 'warn',
      title: 'Setup is half done',
      body: 'The decoys are registered here but the SQL has not been run in Supabase yet, so nothing is being watched.',
    };
  }

  const n = state.compromised.length;
  if (n > 0) {
    return {
      tone: 'critical',
      title: `${n} decoy row${n === 1 ? ' was' : 's were'} touched`,
      body: 'Nothing in your application reads or writes these rows, so this is not a false positive. Rotate your service role key, then re-plant below.',
    };
  }

  // Blindness outranks quiet. A project whose detector could not be confirmed
  // must never be told everything is fine.
  const blind = unreviewed.find((e) => BLIND_KINDS.has(e.kind));
  if (blind) {
    return {
      tone: 'warn',
      title: 'Detection is not confirmed',
      body: `${eventLegend(blind.kind).meaning} Silence right now does not mean all clear.`,
    };
  }

  const intrusion = unreviewed.find((e) => isIntrusion(e.kind));
  if (intrusion) {
    const legend = eventLegend(intrusion.kind);
    return { tone: 'critical', title: legend.label, body: legend.meaning };
  }

  const count = state.decoys.length;
  return {
    tone: 'ok',
    title: 'Armed — no decoy row has been touched',
    body: `${count} decoy row${count === 1 ? '' : 's'} in place, and the detection chain answered on the last self-test.`,
  };
}

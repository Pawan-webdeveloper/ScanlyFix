import type { CanaryDetection, CanaryEventKind } from './types';

/** What each kind of event means, in the words a developer would use. */
const KIND_HEADLINE: Readonly<Record<CanaryEventKind, string>> = {
  modified: 'A decoy row was modified',
  deleted: 'A decoy row was deleted',
  row_added: 'A row was added to the decoy table',
  anon_readable: 'The decoy table is reachable with your public anon key',
  log_wiped: 'The decoy trigger log was cut down',
  honeytoken_hit: 'A honeytoken URL was used',
  table_missing: 'The decoy table is gone',
  watch_disabled: 'Canary monitoring is not running',
  unreachable: 'Your database could not be reached',
};

/** The first thing to do about each kind. An alert without a next step is an interruption. */
const KIND_ACTION: Readonly<Record<CanaryEventKind, string>> = {
  modified:
    'Check your database audit log for writes to this table around the time shown, then rotate any credential that could reach it.',
  deleted:
    'Check your database audit log for deletes around the time shown. Rotate the service role key — whatever performed this had write access.',
  row_added:
    'Only the setup script ever inserts into that table, so something else can write to it. Check for a row level security policy granting INSERT, and rotate the service role key.',
  anon_readable:
    'Enable row level security on this table and remove any policy that grants the anon role access. Your anon key ships in the browser, so anything it can reach is public.',
  log_wiped:
    'Rows are only ever added to that log, so entries were removed deliberately. Treat the database as compromised and rotate every key that can reach it.',
  honeytoken_hit:
    'The data holding that URL is already outside your database. Rotate the credentials in the affected tables and work out what else was in the same export.',
  table_missing:
    'Re-run the setup SQL from Runtime → Canaries, or reconnect the right database. Nothing is being watched until you do.',
  watch_disabled: 'Reconnect the database from Runtime → Canaries. The decoys are not being checked.',
  unreachable:
    'Check whether the Supabase project is paused and whether the service role key is still valid. Checks are not running until it responds.',
};

/** Worst first, so the subject line and the first bullet are the ones that matter. */
const KIND_RANK: Readonly<Record<CanaryEventKind, number>> = {
  honeytoken_hit: 0,
  deleted: 1,
  modified: 2,
  row_added: 2.5,
  log_wiped: 3,
  anon_readable: 4,
  table_missing: 5,
  watch_disabled: 6,
  unreachable: 7,
};

/**
 * Kinds that mean "somebody was in there", as opposed to "we cannot see".
 *
 * They read very differently to a recipient at 3am, and mixing them under one
 * alarming subject line is how a monitoring product teaches people to ignore it.
 */
const IS_INTRUSION: ReadonlySet<CanaryEventKind> = new Set<CanaryEventKind>([
  'modified',
  'deleted',
  'row_added',
  'log_wiped',
  'honeytoken_hit',
  'anon_readable',
]);

function headline(kind: CanaryEventKind): string {
  return KIND_HEADLINE[kind] ?? kind;
}

export function buildCanaryAlertEmail(input: {
  hostname: string;
  detections: CanaryDetection[];
  /** Absolute dashboard URL, when one can be built. */
  dashboardUrl?: string | null;
}): { subject: string; text: string } {
  const sorted = [...input.detections].sort((a, b) => (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99));
  const worst = sorted[0];
  const intrusion = sorted.some((d) => IS_INTRUSION.has(d.kind));

  const subject = intrusion
    ? `🚨 Database canary triggered on ${input.hostname} — ${headline(worst?.kind ?? 'modified').toLowerCase()}`
    : `⚠️ Canary monitoring on ${input.hostname} is not running`;

  const lines: string[] = [];

  if (intrusion) {
    lines.push(
      `A decoy in the database behind ${input.hostname} was touched.`,
      '',
      'These rows exist only so that nothing ever reads or writes them. No feature, no migration, no cron job',
      'and no user touches them. So this is not a signal to weigh up — something reached a place nothing should.',
    );
  } else {
    lines.push(
      `Canary checks for ${input.hostname} could not complete.`,
      '',
      'This is not an intrusion alert. It means the decoys have stopped being watched, so an intrusion',
      'would now go unreported.',
    );
  }

  lines.push('', 'What happened:');
  for (const d of sorted) {
    const when = d.occurredAt ? ` at ${d.occurredAt}` : '';
    lines.push(`  • ${headline(d.kind)}${when}`);
    lines.push(`    ${d.detail}`);
    // Trigger-log evidence comes from the database itself, which is worth saying.
    if (d.source === 'trigger_log') {
      lines.push('    Recorded by a trigger inside your own database at the moment it happened.');
    }
  }

  const actions = [...new Set(sorted.map((d) => KIND_ACTION[d.kind]).filter(Boolean))];
  if (actions.length > 0) {
    lines.push('', 'What to do:');
    for (const action of actions) lines.push(`  • ${action}`);
  }

  lines.push('', 'The full timeline, with every event and its exact time, is in Runtime → Canaries.');
  if (input.dashboardUrl) lines.push(input.dashboardUrl);

  return { subject, text: lines.join('\n') };
}

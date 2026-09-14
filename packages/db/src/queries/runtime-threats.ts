import { and, desc, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import { runtimeThreatEvents } from '../schema.ts';

/**
 * Reading and writing the live threat feed.
 *
 * The one idea worth carrying out of this file: a single sign-in attempt is not
 * an attack, and neither is a single failed password. Recording them is still
 * worth it, because twenty of them from one address in ten minutes IS an attack
 * and there is no other way to see that. So they are stored like anything else
 * and then kept OUT of the feed, surfacing only through the rollup below. The
 * alternative — showing every login attempt as a "threat" — would fill a
 * security console with the customer's own users.
 */

export type ThreatEventInput = {
  kind: string;
  severity: string;
  confidence: string;
  ruleId: string;
  surface: string;
  method: string;
  pattern: string;
  evidence: string;
  sourceIp: string | null;
  userAgent: string | null;
  blocked: boolean;
  responseStatus: number | null;
  eventCount: number;
  source?: string;
};

export type ThreatEventRow = typeof runtimeThreatEvents.$inferSelect;

/** Signals rather than findings: real, recorded, and never shown on their own. */
export const SIGNAL_ONLY_KINDS: ReadonlyArray<string> = ['auth_attempt', 'auth_failure'];

export async function recordThreatEvents(projectId: string, events: ThreatEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await db
    .insert(runtimeThreatEvents)
    .values(events.map((e) => ({ ...e, projectId, source: e.source ?? 'sdk' })))
    .returning({ id: runtimeThreatEvents.id });
  return rows.length;
}

export type ListThreatsOptions = {
  limit?: number;
  /** Only events at or after this moment. Used by the console's live polling. */
  since?: Date;
  /** Keyset pagination: only events strictly older than this. */
  before?: Date;
  kinds?: ReadonlyArray<string>;
  severities?: ReadonlyArray<string>;
  /** Include the sign-in signals the feed normally hides. */
  includeSignals?: boolean;
};

export async function listThreatEvents(
  projectId: string,
  opts: ListThreatsOptions = {},
): Promise<ThreatEventRow[]> {
  const where = [eq(runtimeThreatEvents.projectId, projectId)];

  if (!opts.includeSignals) where.push(notInArray(runtimeThreatEvents.kind, [...SIGNAL_ONLY_KINDS]));
  if (opts.since) where.push(gte(runtimeThreatEvents.detectedAt, opts.since));
  if (opts.before) where.push(lt(runtimeThreatEvents.detectedAt, opts.before));
  if (opts.kinds?.length) where.push(inArray(runtimeThreatEvents.kind, [...opts.kinds]));
  if (opts.severities?.length) where.push(inArray(runtimeThreatEvents.severity, [...opts.severities]));

  return db
    .select()
    .from(runtimeThreatEvents)
    .where(and(...where))
    .orderBy(desc(runtimeThreatEvents.detectedAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
}

export type ThreatTotals = {
  critical: number;
  high: number;
  medium: number;
  blocked: number;
  total: number;
};

/** Severity counts over a window. Drives the headline numbers on the console. */
export async function threatTotals(projectId: string, since: Date): Promise<ThreatTotals> {
  const [row] = await db
    .select({
      critical: sql<number>`count(*) filter (where ${runtimeThreatEvents.severity} = 'critical')::int`,
      high: sql<number>`count(*) filter (where ${runtimeThreatEvents.severity} = 'high')::int`,
      medium: sql<number>`count(*) filter (where ${runtimeThreatEvents.severity} = 'medium')::int`,
      blocked: sql<number>`count(*) filter (where ${runtimeThreatEvents.blocked})::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(runtimeThreatEvents)
    .where(
      and(
        eq(runtimeThreatEvents.projectId, projectId),
        gte(runtimeThreatEvents.detectedAt, since),
        notInArray(runtimeThreatEvents.kind, [...SIGNAL_ONLY_KINDS]),
      ),
    );

  return row ?? { critical: 0, high: 0, medium: 0, blocked: 0, total: 0 };
}

export type ThreatGroup = { key: string; count: number; lastSeen: Date };

/** Attack classes seen in the window, worst-represented first. */
export async function threatsByKind(projectId: string, since: Date, limit = 12): Promise<ThreatGroup[]> {
  return db
    .select({
      key: runtimeThreatEvents.kind,
      count: sql<number>`count(*)::int`,
      lastSeen: sql<Date>`max(${runtimeThreatEvents.detectedAt})`,
    })
    .from(runtimeThreatEvents)
    .where(
      and(
        eq(runtimeThreatEvents.projectId, projectId),
        gte(runtimeThreatEvents.detectedAt, since),
        notInArray(runtimeThreatEvents.kind, [...SIGNAL_ONLY_KINDS]),
      ),
    )
    .groupBy(runtimeThreatEvents.kind)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

export type ThreatSource = {
  sourceIp: string;
  count: number;
  kinds: number;
  lastSeen: Date;
  blocked: number;
};

/**
 * Addresses worth blocking, busiest first.
 *
 * Sign-in signals are counted in `count` but NOT in `kinds`, and the split is
 * deliberate. An address doing four hundred sign-ins belongs on this list — it
 * is the single most blockable thing a site sees — so excluding the signals
 * entirely would hide the attacker who only ever hits the login page. But
 * "sign-in attempt" is not an attack type, and letting it inflate that column
 * would tell an operator an address tried five kinds of attack when it tried
 * three.
 *
 * Rows with no address are excluded rather than bucketed together: a source you
 * cannot name is a source you cannot block, and listing it as "unknown ×400"
 * next to real addresses invites someone to act on it.
 */
export async function topThreatSources(projectId: string, since: Date, limit = 10): Promise<ThreatSource[]> {
  return db
    .select({
      sourceIp: sql<string>`${runtimeThreatEvents.sourceIp}`,
      count: sql<number>`sum(${runtimeThreatEvents.eventCount})::int`,
      kinds: sql<number>`count(distinct ${runtimeThreatEvents.kind}) filter (where ${runtimeThreatEvents.kind} <> all(array['auth_attempt','auth_failure']))::int`,
      lastSeen: sql<Date>`max(${runtimeThreatEvents.detectedAt})`,
      blocked: sql<number>`count(*) filter (where ${runtimeThreatEvents.blocked})::int`,
    })
    .from(runtimeThreatEvents)
    .where(
      and(
        eq(runtimeThreatEvents.projectId, projectId),
        gte(runtimeThreatEvents.detectedAt, since),
        sql`${runtimeThreatEvents.sourceIp} is not null`,
      ),
    )
    .groupBy(runtimeThreatEvents.sourceIp)
    .orderBy(desc(sql`sum(${runtimeThreatEvents.eventCount})`))
    .limit(limit);
}

/** Routes taking the most fire, so the customer knows where to look first. */
export async function topThreatTargets(projectId: string, since: Date, limit = 8): Promise<ThreatGroup[]> {
  return db
    .select({
      key: runtimeThreatEvents.pattern,
      count: sql<number>`count(*)::int`,
      lastSeen: sql<Date>`max(${runtimeThreatEvents.detectedAt})`,
    })
    .from(runtimeThreatEvents)
    .where(
      and(
        eq(runtimeThreatEvents.projectId, projectId),
        gte(runtimeThreatEvents.detectedAt, since),
        notInArray(runtimeThreatEvents.kind, [...SIGNAL_ONLY_KINDS]),
      ),
    )
    .groupBy(runtimeThreatEvents.pattern)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

export type AuthPressure = {
  sourceIp: string | null;
  /** Sign-ins observed, including the ones the SDK's throttle folded together. */
  attempts: number;
  /** Of those, the ones the application itself confirmed had failed. */
  failures: number;
  lastSeen: Date;
  firstSeen: Date;
  pattern: string;
};

/**
 * Sign-in pressure per source inside a window.
 *
 * Both numbers are returned rather than one score, because they support
 * different sentences. "412 sign-in attempts" is a fact we observed from
 * outside the login handler; "17 failed sign-ins" is one the application told
 * us, and only the second can be called password guessing without qualification.
 */
export async function authPressureBySource(projectId: string, since: Date, limit = 20): Promise<AuthPressure[]> {
  return db
    .select({
      sourceIp: runtimeThreatEvents.sourceIp,
      attempts: sql<number>`sum(${runtimeThreatEvents.eventCount})::int`,
      failures: sql<number>`coalesce(sum(${runtimeThreatEvents.eventCount}) filter (where ${runtimeThreatEvents.kind} = 'auth_failure'), 0)::int`,
      lastSeen: sql<Date>`max(${runtimeThreatEvents.detectedAt})`,
      firstSeen: sql<Date>`min(${runtimeThreatEvents.detectedAt})`,
      pattern: sql<string>`min(${runtimeThreatEvents.pattern})`,
    })
    .from(runtimeThreatEvents)
    .where(
      and(
        eq(runtimeThreatEvents.projectId, projectId),
        gte(runtimeThreatEvents.detectedAt, since),
        inArray(runtimeThreatEvents.kind, [...SIGNAL_ONLY_KINDS]),
      ),
    )
    .groupBy(runtimeThreatEvents.sourceIp)
    .orderBy(desc(sql`sum(${runtimeThreatEvents.eventCount})`))
    .limit(limit);
}

/** Most recent event of any kind, including signals — "are we receiving anything at all". */
export async function lastThreatEventAt(projectId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${runtimeThreatEvents.detectedAt})` })
    .from(runtimeThreatEvents)
    .where(eq(runtimeThreatEvents.projectId, projectId));
  return row?.at ?? null;
}

/**
 * Removes the events the console generated to demonstrate the feature.
 *
 * Kept separate from `pruneThreatEvents` so that "clear the demo" can never
 * touch a real detection, whatever its age.
 */
export async function deleteSampleThreatEvents(projectId: string): Promise<number> {
  const rows = await db
    .delete(runtimeThreatEvents)
    .where(and(eq(runtimeThreatEvents.projectId, projectId), eq(runtimeThreatEvents.source, 'sample')))
    .returning({ id: runtimeThreatEvents.id });
  return rows.length;
}

/**
 * Retention.
 *
 * The table is written by anonymous internet traffic, so it has no natural
 * ceiling. Nothing here is evidence anyone needs a year later — the point of
 * the feed is what is happening now and what happened this week.
 */
export async function pruneThreatEvents(olderThan: Date): Promise<number> {
  const rows = await db
    .delete(runtimeThreatEvents)
    .where(lt(runtimeThreatEvents.detectedAt, olderThan))
    .returning({ id: runtimeThreatEvents.id });
  return rows.length;
}

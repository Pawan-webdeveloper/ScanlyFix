import { and, desc, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';

import { db } from '../client.ts';
import { projects, runtimeCanaries, runtimeCanaryEvents } from '../schema.ts';

export type CanaryProjectConfig = {
  projectId: string;
  supabaseUrl: string;
  serviceKey: string; // DECRYPTED — Only in memory, never on the wire.
  anonKey: string | null;
  snapshot: CanarySnapshot | null;
};

/**
 * The tamper-evidence baseline for one project.
 *
 * `lastLogId` is the trigger-log watermark: rows above it have not been
 * reported yet. It is optional because snapshots written before the log was
 * read have none, and those are re-baselined rather than replayed — reporting a
 * project's whole trigger history as fresh intrusions would be a false positive
 * at the worst possible scale.
 */
export type CanarySnapshot = {
  payloadHashes: Record<string, string>;
  logRowCount: number;
  lastLogId?: number;
  takenAt: string;
};

export type CanaryProjectConfigRaw = {
  projectId: string;
  supabaseUrl: string;
  serviceKeyEnc: string;
  anonKeyEnc: string | null;
  snapshot: CanaryProjectConfig['snapshot'];
};

/** Returns raw encrypted values — caller must decrypt with their encryption layer. */
export async function getCanaryProjectConfigRaw(projectId: string): Promise<CanaryProjectConfigRaw | null> {
  const [row] = await db
    .select({
      id: projects.id,
      supabaseUrl: projects.supabaseUrl,
      serviceKeyEnc: projects.supabaseServiceKeyEnc,
      anonKeyEnc: projects.supabaseAnonKeyEnc,
      snapshot: projects.canarySnapshot,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!row?.supabaseUrl || !row.serviceKeyEnc) return null;

  return {
    projectId: row.id,
    supabaseUrl: row.supabaseUrl,
    serviceKeyEnc: row.serviceKeyEnc,
    anonKeyEnc: row.anonKeyEnc ?? null,
    snapshot: row.snapshot ?? null,
  };
}

/** Returns decrypted config. decryptFn provided by caller to avoid cross-package import. */
export async function getCanaryProjectConfig(
  projectId: string,
  decryptFn?: (enc: string) => string,
): Promise<CanaryProjectConfig | null> {
  const raw = await getCanaryProjectConfigRaw(projectId);
  if (!raw) return null;

  // If no decrypt fn provided, return null safely (prevents bad cross-package import)
  if (!decryptFn) return null;

  try {
    return {
      projectId: raw.projectId,
      supabaseUrl: raw.supabaseUrl,
      serviceKey: decryptFn(raw.serviceKeyEnc),
      anonKey: raw.anonKeyEnc ? decryptFn(raw.anonKeyEnc) : null,
      snapshot: raw.snapshot,
    };
  } catch (err) {
    console.error(`[getCanaryProjectConfig] Failed to decrypt credentials for project ${projectId}:`, err);
    return null;
  }
}

export async function saveSupabaseConnection(projectId: string, url: string, serviceKeyEnc: string, anonKeyEnc: string | null): Promise<void> {
  await db
    .update(projects)
    .set({ supabaseUrl: url, supabaseServiceKeyEnc: serviceKeyEnc, supabaseAnonKeyEnc: anonKeyEnc })
    .where(eq(projects.id, projectId));
}

export async function clearSupabaseConnection(projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({
      supabaseUrl: null, supabaseServiceKeyEnc: null, supabaseAnonKeyEnc: null,
      canariesSetupAt: null, canarySnapshot: null,
    })
    .where(eq(projects.id, projectId));
}

export async function markCanariesSetup(projectId: string, snapshot: CanaryProjectConfig['snapshot']): Promise<void> {
  await db
    .update(projects)
    .set({ canariesSetupAt: new Date(), canarySnapshot: snapshot })
    .where(eq(projects.id, projectId));
  await db
    .update(runtimeCanaries)
    .set({ status: 'planted', plantedAt: new Date() })
    .where(and(eq(runtimeCanaries.projectId, projectId), eq(runtimeCanaries.status, 'pending_script')));
}

export async function listCanaries(projectId: string, opts: { includeRetired?: boolean } = {}) {
  if (opts.includeRetired) {
    return db.select().from(runtimeCanaries).where(eq(runtimeCanaries.projectId, projectId)).orderBy(runtimeCanaries.markerToken);
  }
  return db
    .select()
    .from(runtimeCanaries)
    .where(and(eq(runtimeCanaries.projectId, projectId), ne(runtimeCanaries.status, 'retired')))
    .orderBy(runtimeCanaries.markerToken);
}

export async function retireCanaries(projectId: string): Promise<void> {
  await db
    .update(runtimeCanaries)
    .set({ status: 'retired' })
    .where(eq(runtimeCanaries.projectId, projectId));
}

/**
 * Registers the decoy rows a setup script is about to plant.
 *
 * Returns the number actually inserted, which the caller MUST check. A conflict
 * here is not a harmless no-op: it means the markers collided with rows we
 * already hold, the honeytoken paths in the SQL the customer is about to paste
 * were never stored, and every future hit on them will be discarded. Silently
 * swallowing that is how the compromise-recovery path used to fail.
 */
export async function seedCanaries(
  projectId: string,
  seeds: Array<{ marker: string; honeytokenPath: string; kind?: string }>,
): Promise<number> {
  if (seeds.length === 0) return 0;
  const inserted = await db
    .insert(runtimeCanaries)
    .values(
      seeds.map((s) => ({
        projectId,
        markerToken: s.marker,
        honeytokenPath: s.honeytokenPath,
        kind: s.kind ?? 'vault',
        status: 'pending_script',
      })),
    )
    .onConflictDoNothing()
    .returning({ id: runtimeCanaries.id });
  return inserted.length;
}

export async function acknowledgeCanaryEvent(projectId: string, eventId: string): Promise<void> {
  await db
    .update(runtimeCanaryEvents)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(runtimeCanaryEvents.projectId, projectId), eq(runtimeCanaryEvents.id, eventId)));
}

export async function updateCanaryStatus(projectId: string, marker: string, status: string, integrity: string): Promise<void> {
  await db
    .update(runtimeCanaries)
    .set({ status, lastIntegrity: integrity, lastCheckedAt: new Date() })
    .where(and(eq(runtimeCanaries.projectId, projectId), eq(runtimeCanaries.markerToken, marker)));
}

export async function insertCanaryEvents(
  events: Array<{ projectId: string; canaryId: string | null; kind: string; detail: string; source: string }>,
): Promise<number> {
  if (events.length === 0) return 0;
  const rows = await db.insert(runtimeCanaryEvents).values(events).returning({ id: runtimeCanaryEvents.id });
  return rows.length;
}

export async function listCanaryEvents(projectId: string, limit = 50) {
  return db
    .select()
    .from(runtimeCanaryEvents)
    .where(eq(runtimeCanaryEvents.projectId, projectId))
    .orderBy(desc(runtimeCanaryEvents.detectedAt))
    .limit(limit);
}

export async function countCanaryEvents(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runtimeCanaryEvents)
    .where(eq(runtimeCanaryEvents.projectId, projectId));
  return row?.n ?? 0;
}

export async function hasRecentDuplicateEvent(
  projectId: string,
  kind: string,
  detail: string,
  withinHours = 24,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinHours * 60 * 60 * 1000);
  const [row] = await db
    .select({ id: runtimeCanaryEvents.id })
    .from(runtimeCanaryEvents)
    .where(
      and(
        eq(runtimeCanaryEvents.projectId, projectId),
        eq(runtimeCanaryEvents.kind, kind),
        eq(runtimeCanaryEvents.detail, detail),
        gte(runtimeCanaryEvents.detectedAt, cutoff),
      ),
    )
    .limit(1);
  return !!row;
}

export async function listCanaryEligibleProjectIds(): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(isNotNull(projects.canariesSetupAt), isNotNull(projects.supabaseServiceKeyEnc)));
  return rows.map((r) => r.id);
}

/**
 * Resolves a honeytoken path to the canary it belongs to.
 *
 * Deliberately matches on the path alone, whatever state the canary is in. The
 * previous version required status='planted', which meant that once a canary
 * was marked compromised — or retired during recovery — hits on its honeytoken
 * were discarded. That is exactly backwards: the payload carrying that URL is
 * already out in the world, and a hit on it is the strongest evidence the
 * product can produce that the leaked data is being used. The caller gets the
 * status so it can say which generation was touched.
 */
export async function findCanaryByHoneytoken(token: string) {
  const [row] = await db
    .select({
      id: runtimeCanaries.id,
      projectId: runtimeCanaries.projectId,
      markerToken: runtimeCanaries.markerToken,
      status: runtimeCanaries.status,
    })
    .from(runtimeCanaries)
    .where(eq(runtimeCanaries.honeytokenPath, token))
    .limit(1);
  return row ?? null;
}

/** Counts honeytoken_hit events for a specific canary within the cooldown window (in minutes). */
export async function countRecentHoneytokenHits(
  canaryId: string,
  withinMinutes = 60,
): Promise<number> {
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runtimeCanaryEvents)
    .where(
      and(
        eq(runtimeCanaryEvents.canaryId, canaryId),
        eq(runtimeCanaryEvents.kind, 'honeytoken_hit'),
        gte(runtimeCanaryEvents.detectedAt, cutoff),
      ),
    );
  return row?.n ?? 0;
}
import {
  getCanaryProjectConfig,
  hasRecentDuplicateEvent,
  insertCanaryEvents,
  listCanaries,
  markCanariesSetup,
  updateCanaryStatus,
  type CanaryProjectConfig,
} from '@scanlyfix/db';

import { decryptValue } from '@/lib/header-encryption';

import { evaluateIntegrity, type TriggerLogRow } from './integrity';
import { buildAnonAuditReport, evaluateAnonProbe, evaluateAnonWriteProbe, type AnonProbeResult } from './rls-probe';
import {
  listTableNames,
  restHeadCount,
  restProbeAnonInsert,
  restSelect,
  restUpdatePayload,
  type RestConfig,
} from './supabase-rest';
import {
  CANARY_LOG_TABLE,
  CANARY_TABLE,
  MAX_AUDIT_TABLES,
  MAX_LOG_ROWS_PER_CHECK,
  SELFTEST_KIND,
  type CanaryDetection,
} from './types';

export type CanaryRunSummary = {
  projectId: string;
  ranAt: string;
  reachable: boolean;
  detections: CanaryDetection[];
  integrity: Record<string, string>;
  newSnapshot: CanaryProjectConfig['snapshot'];
  /** Detections that were real but already reported recently, so no alert was raised. */
  suppressed: number;
};

/** How long the same state-derived detail is suppressed for. */
const DEDUPE_WINDOW_HOURS = 24;

function emptySummary(projectId: string): CanaryRunSummary {
  return {
    projectId,
    ranAt: new Date().toISOString(),
    reachable: false,
    detections: [],
    integrity: {},
    newSnapshot: null,
    suppressed: 0,
  };
}

/**
 * Reads the trigger log above the watermark.
 *
 * One page is fetched, oldest first, so the report reads chronologically and an
 * intruder cannot make the engine pull an unbounded result set by writing in a
 * loop. One extra row is requested so the caller can tell a full page from a
 * complete one.
 */
async function readNewLogRows(
  rest: RestConfig,
  sinceId: number,
): Promise<{ rows: TriggerLogRow[]; ok: boolean; status: number }> {
  const res = await restSelect<TriggerLogRow>(rest, CANARY_LOG_TABLE, {
    query: `select=id,canary_marker,action,acted_at&id=gt.${sinceId}&order=id.asc`,
    limit: MAX_LOG_ROWS_PER_CHECK + 1,
  });
  if (!res.ok || !res.data) return { rows: [], ok: false, status: res.status };
  return { rows: res.data, ok: true, status: res.status };
}

/**
 * Proves the detection chain still works, before anything is judged.
 *
 * Without this, "no alert tonight" has too many possible meanings: nothing
 * happened; the trigger was dropped; the log table was dropped; the service role
 * lost its grant; PostgREST's schema cache is stale. A product that sells proof
 * cannot ship a silence it cannot account for.
 *
 * So one row — planted for this purpose and owned by us — is rewritten with a
 * fresh value, and the log is then asked whether it noticed. Its own log entries
 * and payload changes are excluded from detection everywhere else, so this can
 * never manufacture an alert.
 *
 * Returns null when the chain responded, or a detection describing what is
 * broken when it did not.
 */
async function runSelfTest(
  rest: RestConfig,
  selfTestMarker: string,
  watermark: number,
): Promise<CanaryDetection | null> {
  const nonce = `selftest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const written = await restUpdatePayload(rest, CANARY_TABLE, selfTestMarker, {
    note: 'ScanlyFix detection self-test — this row is rewritten on every check',
    nonce,
  });

  if (!written.ok) {
    return {
      kind: 'watch_disabled',
      source: 'integrity',
      canaryId: null,
      marker: selfTestMarker,
      detail: `The self-test row could not be written (HTTP ${written.status || 'no response'}). Write detection cannot be confirmed, so an intrusion tonight might not be reported.`,
    };
  }

  const after = await restSelect<{ id: number; canary_marker: string | null }>(rest, CANARY_LOG_TABLE, {
    query: `select=id,canary_marker&canary_marker=eq.${encodeURIComponent(selfTestMarker)}&id=gt.${watermark}&order=id.desc`,
    limit: 1,
  });

  if (after.ok && after.data && after.data.length > 0) return null;

  return {
    kind: 'watch_disabled',
    source: 'trigger_log',
    canaryId: null,
    marker: selfTestMarker,
    detail:
      'The decoy table was written to, but the database trigger recorded nothing. The trigger or its log table has been removed, so writes to your decoy rows are no longer being detected. Re-run the setup SQL from Runtime → Canaries.',
  };
}

/**
 * One full canary check — the nightly cron and the "Run check" button both call this.
 *
 * The order matters. The trigger log is read first because it is the strongest
 * evidence available: it records that a decoy row was touched, with the
 * operation and the timestamp, regardless of what the row looks like now. The
 * state comparison is second and covers what the log cannot — a row altered by
 * something that bypassed the trigger, or a trigger that has been dropped.
 */
export async function runCanaryCheck(projectId: string): Promise<CanaryRunSummary> {
  const summary = emptySummary(projectId);

  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  if (!cfg) {
    // Either no connection, or credentials that no longer decrypt. Both mean
    // this project is not being watched, and silence would read as "all clear".
    summary.detections.push({
      kind: 'watch_disabled',
      source: 'integrity',
      canaryId: null,
      marker: null,
      detail:
        'Canary monitoring could not run: this project has no usable Supabase connection. Reconnect the database from Runtime → Canaries, or the decoys are no longer being watched.',
    });
    await persistDetections(projectId, summary);
    return summary;
  }

  const rest: RestConfig = { url: cfg.supabaseUrl, serviceKey: cfg.serviceKey, anonKey: cfg.anonKey };
  const snapshot = cfg.snapshot ?? null;

  // ── 1. The decoy rows themselves ─────────────────────────────────────────
  const rowsRes = await restSelect<{ marker: string; payload: unknown }>(rest, CANARY_TABLE, {
    query: 'select=marker,payload',
  });

  if (rowsRes.ok && rowsRes.data) {
    summary.reachable = true;

    const canaries = await listCanaries(projectId);
    const selfTest = canaries.find((c) => c.kind === SELFTEST_KIND) ?? null;
    const watermark = snapshot?.lastLogId ?? 0;

    // ── 2. Prove the chain is armed before judging anything ────────────────
    if (selfTest) {
      const broken = await runSelfTest(rest, selfTest.markerToken, watermark);
      if (broken) summary.detections.push({ ...broken, canaryId: selfTest.id });
    }

    // ── 3. The trigger log: history, and the count that reveals a wipe ─────
    const [logPage, logCountRes] = await Promise.all([
      readNewLogRows(rest, watermark),
      // limit=1 matters: the count arrives in the Content-Range header, but
      // without a cap PostgREST also returns every row in the body — a table an
      // intruder can grow without bound by looping writes to a decoy. Ordering
      // descending makes that one row the highest id, which is what tells a
      // deleted-from log apart from a recreated one, at no extra request.
      restSelect<{ id: number }>(rest, CANARY_LOG_TABLE, { query: 'select=id&order=id.desc', withCount: true, limit: 1 }),
    ]);

    // The `ok` flag is the evidence that the log is still readable at all. An
    // earlier version destructured only the rows, which made "the log table was
    // dropped" indistinguishable from "nothing happened" — the exact blindness
    // this check exists to prevent.
    if (!logPage.ok) {
      summary.detections.push({
        kind: 'watch_disabled',
        source: 'integrity',
        canaryId: null,
        marker: null,
        detail: `The decoy trigger log could not be read (HTTP ${logPage.status || 'no response'}). If the table was dropped, writes to your decoy rows are no longer being recorded.`,
      });
    }

    const result = evaluateIntegrity({
      snapshot,
      liveRows: rowsRes.data,
      liveLogCount: logCountRes.count,
      liveMaxLogId: logCountRes.data?.[0]?.id ?? null,
      newLogRows: logPage.rows,
      // Ground truth for what must exist comes from our own table, not from the
      // snapshot mirror, so a marker cannot quietly stop being looked for.
      expectedMarkers: canaries.filter((c) => c.kind !== SELFTEST_KIND).map((c) => c.markerToken),
      selfTestMarker: selfTest?.markerToken ?? null,
    });
    summary.integrity = result.verdicts;
    summary.newSnapshot = result.newSnapshot;
    summary.detections.push(...result.detections);

    // Link each detection to its canary row by the marker it carries, not by
    // testing whether the prose happens to start with one.
    const byMarker = new Map(canaries.map((c) => [c.markerToken, c]));
    for (const detection of summary.detections) {
      if (detection.marker) detection.canaryId = byMarker.get(detection.marker)?.id ?? null;
    }

    for (const c of canaries) {
      const verdict = result.verdicts[c.markerToken];
      if (verdict === 'missing' || verdict === 'modified') {
        await updateCanaryStatus(projectId, c.markerToken, 'compromised', verdict);
      } else if (verdict === 'ok') {
        await updateCanaryStatus(projectId, c.markerToken, 'planted', verdict);
      }
    }

    // ── 3. Can an anonymous caller reach the decoy table? ────────────────────
    if (cfg.anonKey) {
      const readProbe: AnonProbeResult = await restSelect<unknown>(rest, CANARY_TABLE, { key: 'anon', limit: 1 }).then((r) => ({
        status: r.status,
        rowCount: r.data?.length ?? (r.status === 200 ? 0 : null),
      }));
      const readDetection = evaluateAnonProbe(readProbe);
      if (readDetection) summary.detections.push(readDetection);

      // Reading is only half of it: a table anyone can write to is worse.
      const writeProbe = await restProbeAnonInsert(rest, CANARY_TABLE);
      const writeDetection = evaluateAnonWriteProbe(writeProbe);
      if (writeDetection) summary.detections.push(writeDetection);
    }
  } else if (rowsRes.status === 404) {
    // The decoy table is gone. Either the setup was reverted or the connection
    // now points somewhere else. Both mean nothing is being watched.
    summary.detections.push({
      kind: 'table_missing',
      source: 'integrity',
      canaryId: null,
      marker: null,
      detail: `The decoy table "${CANARY_TABLE}" no longer exists in this Supabase project. The setup was removed, or the connection now points at a different database. Nothing is being watched.`,
    });
    // Leaving the rows green would be the worst possible display: a dashboard
    // full of "planted / ok" for decoys that are not there.
    const canaries = await listCanaries(projectId);
    for (const c of canaries) {
      summary.integrity[c.markerToken] = 'missing';
      await updateCanaryStatus(projectId, c.markerToken, 'compromised', 'missing');
    }
  } else {
    // 401/403/5xx/timeout. Nothing is judged — but a watchdog that has been
    // unable to look for days must not present as "all quiet".
    summary.reachable = false;
    const canaries = await listCanaries(projectId);
    for (const c of canaries) {
      summary.integrity[c.markerToken] = 'unreachable';
      await updateCanaryStatus(projectId, c.markerToken, c.status, 'unreachable');
    }
    summary.detections.push({
      kind: 'unreachable',
      source: 'integrity',
      canaryId: null,
      marker: null,
      detail: `Supabase could not be reached for this check (HTTP ${rowsRes.status || 'no response'}). Canaries were not verified. If the project is paused or the service key was rotated, monitoring is off until it is fixed.`,
    });
  }

  await persistDetections(projectId, summary);

  // ── 4. Move the baseline forward ─────────────────────────────────────────
  // Only when the rows were actually read. Refreshing after a detection is
  // deliberate: the transition has been recorded as an event, the trigger-log
  // watermark has advanced past the rows just reported, and the current state
  // becomes the baseline the NEXT change is measured against. Freezing the
  // snapshot instead — which is what used to happen — meant one unresolved
  // detection pinned the log baseline forever, so a later wipe could never be
  // seen and the same alert re-sent itself every night.
  if (summary.reachable && summary.newSnapshot) {
    await markCanariesSetup(projectId, summary.newSnapshot);
  }

  return summary;
}

/**
 * Writes the new detections and works out which ones deserve an alert.
 *
 * Trigger-log detections carry a timestamp, so each one is distinct and none is
 * ever suppressed. State-derived detections repeat verbatim for as long as the
 * condition stands, and those are held for a window so a single unresolved
 * problem does not mail the customer every night.
 */
async function persistDetections(projectId: string, summary: CanaryRunSummary): Promise<void> {
  if (summary.detections.length === 0) return;

  const fresh: CanaryDetection[] = [];
  const seenInBatch = new Set<string>();

  for (const d of summary.detections) {
    const key = `${d.kind}::${d.detail}`;
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);

    if (await hasRecentDuplicateEvent(projectId, d.kind, d.detail, DEDUPE_WINDOW_HOURS)) {
      summary.suppressed++;
      continue;
    }
    fresh.push(d);
  }

  if (fresh.length > 0) {
    await insertCanaryEvents(
      fresh.map((d) => ({
        projectId,
        canaryId: d.canaryId,
        kind: d.kind,
        detail: d.detail,
        source: d.source,
      })),
    );
  }

  // Callers alert on what is left, so a suppressed repeat never mails anyone.
  summary.detections = fresh;
}

export type AnonAuditReport = {
  readable: string[];
  protectedCount: number;
  unreachable: number;
  /** Tables that exist but were not probed because of the per-run cap. */
  skipped: number;
  totalTables: number;
};

/**
 * Anon-access audit: ask, as an anonymous visitor, how many rows each table
 * returns. Only table NAMES are ever reported; no row is read (HTTP HEAD with
 * an exact-count preference returns the number and no body).
 *
 * On demand rather than nightly — it is one request per table.
 */
export async function runAnonAccessAudit(projectId: string): Promise<AnonAuditReport | null> {
  const cfg = await getCanaryProjectConfig(projectId, decryptValue);
  if (!cfg?.anonKey) return null;
  const rest: RestConfig = { url: cfg.supabaseUrl, serviceKey: cfg.serviceKey, anonKey: cfg.anonKey };

  const tables = await listTableNames(rest);
  if (!tables) return null;

  const EXCLUDE = new Set([CANARY_TABLE, CANARY_LOG_TABLE]);
  const candidates = tables.filter((t) => !EXCLUDE.has(t));
  const scoped = candidates.slice(0, MAX_AUDIT_TABLES);

  const CHUNK_SIZE = 8;
  const results: Array<{ name: string; anonCount: number | null }> = [];
  for (let i = 0; i < scoped.length; i += CHUNK_SIZE) {
    const chunk = scoped.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(async (name) => {
        const res = await restHeadCount(rest, name);
        return { name, anonCount: res.status === 200 ? (res.count ?? 0) : null };
      }),
    );
    results.push(...chunkResults);
  }

  const report = buildAnonAuditReport(results, EXCLUDE);
  return {
    ...report,
    // The cap used to be invisible, so a database with 60 tables was reported
    // as fully audited after 30. A partial audit has to say so.
    skipped: candidates.length - scoped.length,
    totalTables: candidates.length,
  };
}

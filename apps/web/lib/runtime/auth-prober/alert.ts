import { buildRemediation } from './remediation';
import { CATEGORY_LABEL } from './targets';
import type { ProberFindingItem, ProberRunSummary } from './types';

type AlertFinding = Pick<
  ProberFindingItem,
  'path' | 'severity' | 'baselineStatus' | 'actualStatus' | 'variant' | 'keyFingerprint' | 'category' | 'evidence' | 'reason'
>;

function describe(f: AlertFinding): string {
  const cat = f.category ? ` [${CATEGORY_LABEL[f.category]}]` : '';
  switch (f.variant ?? null) {
    case 'anon_role': {
      const fpSuffix = f.keyFingerprint ? ` [key: ${f.keyFingerprint}]` : '';
      return `• ${f.path} — previously responded with ${f.baselineStatus} (protected), now opens with the public anon key (Supabase RLS/anon-role exposure) returning ${f.actualStatus} OK (${f.severity})${fpSuffix}`;
    }
    case 'exposed':
      return `• ${f.path}${cat} — reachable without login on first probe: HTTP ${f.actualStatus} with real content (${f.severity})`;
    case 'sequential_id':
      return `• ${f.path}${cat} — records enumerable by sequential id without login (IDOR): HTTP ${f.actualStatus} JSON for id=1 and id=2 (${f.severity})`;
    default:
      return `• ${f.path} — previously responded with ${f.baselineStatus} (protected), now responds with ${f.actualStatus} OK without login (${f.severity})`;
  }
}

function evidenceLine(f: AlertFinding): string | null {
  const e = f.evidence;
  if (!e) return null;
  const parts = [e.contentType ? `content-type ${e.contentType}` : null, `${e.bodyBytes} bytes`, e.title ? `title "${e.title}"` : null].filter(Boolean);
  return `    evidence: ${parts.join(', ')}`;
}

/** Clean, plain-language security alert email for auth regressions. */
export function buildProberAlertEmail(input: { projectUrl: string; findings: AlertFinding[] }): { subject: string; text: string } {
  const n = input.findings.length;
  const allAnon = n > 0 && input.findings.every((f) => f.variant === 'anon_role');
  const hasAnon = input.findings.some((f) => f.variant === 'anon_role');
  const allExposed = n > 0 && input.findings.every((f) => f.variant === 'exposed' || f.variant === 'sequential_id');

  const subject = allAnon
    ? `🚨 Auth regression on ${input.projectUrl} — ${n} endpoint(s) open with public anon key (Supabase RLS/anon-role exposure)`
    : allExposed
      ? `🚨 Exposed surface on ${input.projectUrl} — ${n} route(s) reachable without login`
      : hasAnon
        ? `🚨 Auth regression on ${input.projectUrl} — ${n} page(s) exposed (including Supabase anon-role)`
        : `🚨 Auth regression on ${input.projectUrl} — ${n} page(s) stopped requiring login`;

  const body: string[] = [];
  for (const f of input.findings) {
    body.push(describe(f));
    const ev = evidenceLine(f);
    if (ev) body.push(ev);
    const rem = buildRemediation(f);
    body.push(`    fix: ${rem.steps[0]}`);
  }

  return {
    subject,
    text: [
      `ScanlyFix Auth Prober detected a security regression on ${input.projectUrl}:`,
      '',
      ...body,
      '',
      'Each finding in the dashboard includes evidence, step-by-step remediation and a copy-paste fix prompt for your AI coding assistant.',
      'View details and manage findings in your dashboard: Runtime → Auth Prober',
    ].join('\n'),
  };
}

export function summarizeRun(s: ProberRunSummary): string {
  const base = `baseline:${s.baselinesRecorded} checked:${s.checked} new:${s.newFindings} resolved:${s.autoResolved} open:${s.stillOpen} err:${s.errors}`;
  const extra = [
    s.inconclusive ? `inconclusive:${s.inconclusive}` : null,
    s.suppressedAlerts ? `suppressed:${s.suppressedAlerts}` : null,
  ].filter(Boolean);
  return extra.length ? `${base} ${extra.join(' ')}` : base;
}

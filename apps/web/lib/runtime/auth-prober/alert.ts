import type { ProberRunSummary } from './types';

/** Clean, plain-language security alert email for auth regressions. */
export function buildProberAlertEmail(input: {
  projectUrl: string;
  findings: Array<{ path: string; severity: string; baselineStatus: number; actualStatus: number }>;
}): { subject: string; text: string } {
  const lines = input.findings.map(
    (f) =>
      `• ${f.path} — previously responded with ${f.baselineStatus} (protected), now responds with ${f.actualStatus} OK without login (${f.severity})`,
  );
  return {
    subject: `🚨 Auth regression on ${input.projectUrl} — ${input.findings.length} page(s) stopped requiring login`,
    text: [
      `ScanlyFix Auth Prober detected a security regression on ${input.projectUrl}:`,
      '',
      ...lines,
      '',
      'View details and manage findings in your dashboard: Runtime → Auth Prober',
    ].join('\n'),
  };
}

export function summarizeRun(s: ProberRunSummary): string {
  return `baseline:${s.baselinesRecorded} checked:${s.checked} new:${s.newFindings} resolved:${s.autoResolved} open:${s.stillOpen} err:${s.errors}`;
}
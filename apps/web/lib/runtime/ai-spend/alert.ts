import type { AiModelBreakdown, AiUserBreakdown } from '@scanlyfix/db';

import { formatUsd } from '../ai-log/summary.ts';
import { DEFAULT_ABSOLUTE_THRESHOLD_USD, type VelocityVerdict } from './velocity.ts';

/**
 * The spend alert.
 *
 * The old version told the recipient to go and open the dashboard to find out
 * what was happening. An alert that cannot say what is burning the money is
 * just an interruption — by the time someone has logged in, the loop has been
 * running for another ten minutes. Everything needed to act is already in
 * hand when the alert is built, so it goes in the message: which model, which
 * user, and whether this is a spike relative to the project's own normal or
 * simply a busy hour against a threshold someone set low.
 */

export type SpendAlertInput = {
  projectLabel: string;
  verdict: VelocityVerdict;
  windowMicroUsd: number;
  windowMinutes: number;
  ceilingMicroUsd: number | null;
  baselineMicroUsd: number | null;
  topModels: ReadonlyArray<AiModelBreakdown>;
  topUsers: ReadonlyArray<AiUserBreakdown>;
  /** Absolute dashboard URL, when one can be built. */
  dashboardUrl?: string | null;
};

function shortHash(hash: string | null): string {
  if (!hash) return 'unattributed';
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

/** One line naming the reason, in the words a developer would use. */
export function describeReason(input: SpendAlertInput): string {
  const { verdict } = input;
  switch (verdict.reason) {
    case 'ceiling':
      return `Projected ${formatUsd(verdict.projectedHourlyMicroUsd)}/hour against your ${formatUsd(input.ceilingMicroUsd ?? 0)}/hour threshold (${verdict.pctOfCeiling}%).`;
    case 'baseline_spike':
      return `Projected ${formatUsd(verdict.projectedHourlyMicroUsd)}/hour — ${verdict.baselineMultiple}× this project's normal ${formatUsd(input.baselineMicroUsd ?? 0)}/hour.`;
    case 'absolute':
      return `Projected ${formatUsd(verdict.projectedHourlyMicroUsd)}/hour, over the default $${DEFAULT_ABSOLUTE_THRESHOLD_USD}/hour guard.`;
    default:
      return `Projected ${formatUsd(verdict.projectedHourlyMicroUsd)}/hour.`;
  }
}

export function buildSpendAlertEmail(input: SpendAlertInput): { subject: string; text: string } {
  const { verdict } = input;
  const isCritical = verdict.severity === 'critical';

  const headline =
    verdict.reason === 'baseline_spike'
      ? `${verdict.baselineMultiple}× normal — ${formatUsd(verdict.projectedHourlyMicroUsd)}/h`
      : verdict.reason === 'ceiling'
        ? `${verdict.pctOfCeiling}% of your threshold — ${formatUsd(verdict.projectedHourlyMicroUsd)}/h`
        : `${formatUsd(verdict.projectedHourlyMicroUsd)}/h`;

  const subject = `${isCritical ? '🚨' : '💸'} AI spend on ${input.projectLabel} — ${headline}`;

  const lines: string[] = [
    describeReason(input),
    '',
    `Last ${input.windowMinutes} minutes: ${formatUsd(input.windowMicroUsd)}`,
  ];

  // ── What is actually spending it ────────────────────────────────────────
  const models = input.topModels.filter((m) => m.costMicroUsd > 0).slice(0, 3);
  if (models.length > 0) {
    lines.push('', 'Models driving it:');
    for (const m of models) {
      const errorNote = m.errors > 0 ? `, ${m.errors} failed` : '';
      lines.push(`  • ${m.model} — ${formatUsd(m.costMicroUsd)} over ${m.calls} call${m.calls === 1 ? '' : 's'}${errorNote}`);
    }
  }

  const users = input.topUsers.filter((u) => u.costMicroUsd > 0).slice(0, 3);
  if (users.length > 0) {
    const total = users.reduce((sum, u) => sum + u.costMicroUsd, 0);
    const top = users[0];
    lines.push('', 'Attribution:');
    for (const u of users) {
      lines.push(`  • ${shortHash(u.userHash)} — ${formatUsd(u.costMicroUsd)} over ${u.calls} call${u.calls === 1 ? '' : 's'}`);
    }
    // A single caller holding almost all of the spend is the signature of a loop.
    if (top && total > 0 && top.costMicroUsd / total >= 0.8) {
      lines.push(
        '',
        `${shortHash(top.userHash)} accounts for ${Math.round((top.costMicroUsd / total) * 100)}% of this. That pattern is usually a retry loop or a runaway job rather than real usage.`,
      );
    }
  }

  lines.push(
    '',
    'To stop it now: set a lower hourly threshold in the dashboard. The SDK firewall picks the new ceiling up within five minutes and refuses calls before they reach the provider — no redeploy.',
  );
  if (input.dashboardUrl) lines.push('', input.dashboardUrl);

  return { subject, text: lines.join('\n') };
}

/**
 * Derived numbers for the AI console.
 *
 * Every input here comes from a SQL aggregate over the real window. The
 * dashboard used to compute its totals in JavaScript from `listRecentAiCalls`,
 * which is capped at 100 rows, and rendered the result underneath a correctly
 * summed 24-hour cost — so a project making thousands of calls a day was told
 * it had made a hundred. Nothing in this file reads the call list.
 */

import type { AiErrorBreakdown, AiModelBreakdown, AiStats, AiUserBreakdown } from '@scanlyfix/db';

export type AiDerived = {
  totalCalls: number;
  successCalls: number;
  errorCalls: number;
  /** Whole percent of calls that failed. 0 when there were none. */
  errorRatePct: number;
  totalCostMicroUsd: number;
  totalTokens: number;
  /** Mean cost of a successful call — the number that makes a model choice concrete. */
  avgCostPerCallMicroUsd: number;
  avgTokensPerCall: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  distinctUsers: number;
};

export function deriveAiStats(stats: AiStats): AiDerived {
  const successCalls = Math.max(0, stats.totalCalls - stats.errorCalls);
  const totalTokens = stats.totalPromptTokens + stats.totalCompletionTokens;
  return {
    totalCalls: stats.totalCalls,
    successCalls,
    errorCalls: stats.errorCalls,
    errorRatePct: stats.totalCalls > 0 ? Math.round((stats.errorCalls / stats.totalCalls) * 100) : 0,
    totalCostMicroUsd: stats.totalCostMicroUsd,
    totalTokens,
    avgCostPerCallMicroUsd: successCalls > 0 ? Math.round(stats.totalCostMicroUsd / successCalls) : 0,
    avgTokensPerCall: successCalls > 0 ? Math.round(totalTokens / successCalls) : 0,
    p50LatencyMs: stats.p50LatencyMs,
    p95LatencyMs: stats.p95LatencyMs,
    distinctUsers: stats.distinctUsers,
  };
}

/** Share of total spend held by the single largest caller, or null when nothing is attributed. */
export function topUserSharePct(byUser: ReadonlyArray<AiUserBreakdown>): number | null {
  const attributed = byUser.filter((u) => u.userHash !== null && u.costMicroUsd > 0);
  const total = attributed.reduce((sum, u) => sum + u.costMicroUsd, 0);
  const top = attributed[0];
  if (!top || total <= 0) return null;
  return Math.round((top.costMicroUsd / total) * 100);
}

/** Share of total spend held by one model — which model choice is the bill. */
export function modelSharePct(model: AiModelBreakdown, byModel: ReadonlyArray<AiModelBreakdown>): number {
  const total = byModel.reduce((sum, m) => sum + m.costMicroUsd, 0);
  if (total <= 0) return 0;
  return Math.round((model.costMicroUsd / total) * 100);
}

/** Human labels for the closed set of failure kinds. */
export const ERROR_KIND_LABEL: Readonly<Record<string, string>> = {
  ceiling: 'Blocked by your spend ceiling',
  rate_limit: 'Provider rate limit (429)',
  auth: 'Auth rejected (401/403)',
  bad_request: 'Request rejected (4xx)',
  timeout: 'Timed out',
  server_error: 'Provider error (5xx)',
  network: 'Network failure',
  unknown: 'Unclassified',
};

/** What to do about each failure kind, in one line. */
export const ERROR_KIND_HINT: Readonly<Record<string, string>> = {
  ceiling: 'Your firewall refused these before they reached the provider. Raise the threshold if this is legitimate traffic.',
  rate_limit: 'Add backoff and retry, or request a quota increase from the provider.',
  auth: 'The API key is wrong, revoked, or lacks access to this model.',
  bad_request: 'The request shape is being rejected — usually a model name, a role, or a token limit.',
  timeout: 'Raise the client timeout, or switch to streaming so the first token arrives sooner.',
  server_error: 'A provider-side fault. Retry with backoff; check the provider status page if it persists.',
  network: 'The request never reached the provider. Check egress, DNS and TLS from your runtime.',
  unknown: 'Not classified. Check your application logs for the full error.',
};

export function describeErrors(errors: ReadonlyArray<AiErrorBreakdown>): Array<AiErrorBreakdown & { label: string; hint: string }> {
  return errors.map((e) => ({
    ...e,
    label: ERROR_KIND_LABEL[e.errorKind] ?? ERROR_KIND_LABEL.unknown!,
    hint: ERROR_KIND_HINT[e.errorKind] ?? ERROR_KIND_HINT.unknown!,
  }));
}

/** Compact token count for a dense table: 1_234_567 → "1.2M". */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

import { describe, expect, it } from 'vitest';
import type { AiModelBreakdown, AiStats, AiUserBreakdown } from '@scanlyfix/db';

import {
  deriveAiStats,
  describeErrors,
  ERROR_KIND_HINT,
  ERROR_KIND_LABEL,
  formatLatency,
  formatTokens,
  modelSharePct,
  topUserSharePct,
} from '../lib/runtime/ai-log/stats.ts';
import { AI_ERROR_KINDS as DB_ERROR_KINDS } from '@scanlyfix/db';
import { AI_ERROR_KINDS as SDK_ERROR_KINDS } from '@scanlyfix/runtime-sdk';
import { ALLOWED_AI_ERROR_KINDS } from '../app/api/runtime/ingest/route.ts';
import { buildSpendAlertEmail, describeReason } from '../lib/runtime/ai-spend/alert.ts';
import { evaluateVelocity } from '../lib/runtime/ai-spend/velocity.ts';

const usd = (n: number) => n * 1_000_000;

const stats = (over: Partial<AiStats> = {}): AiStats => ({
  totalCalls: 100,
  errorCalls: 0,
  totalCostMicroUsd: usd(1),
  totalPromptTokens: 50_000,
  totalCompletionTokens: 25_000,
  p50LatencyMs: 300,
  p95LatencyMs: 1800,
  distinctUsers: 4,
  ...over,
});

const model = (over: Partial<AiModelBreakdown> = {}): AiModelBreakdown => ({
  model: 'gpt-4o',
  provider: 'openai',
  calls: 10,
  errors: 0,
  costMicroUsd: usd(1),
  promptTokens: 10_000,
  completionTokens: 5_000,
  p50LatencyMs: 400,
  ...over,
});

const user = (over: Partial<AiUserBreakdown> = {}): AiUserBreakdown => ({
  userHash: 'u_a',
  calls: 10,
  errors: 0,
  costMicroUsd: usd(1),
  ...over,
});

describe('AI derived stats', () => {
  it('separates successes from failures and computes the error rate', () => {
    const d = deriveAiStats(stats({ totalCalls: 200, errorCalls: 50 }));
    expect(d.successCalls).toBe(150);
    expect(d.errorRatePct).toBe(25);
  });

  it('averages cost and tokens over successful calls only', () => {
    // Failures carry zero cost and zero tokens; dividing by every call would
    // understate what a working call actually costs.
    const d = deriveAiStats(stats({ totalCalls: 120, errorCalls: 20, totalCostMicroUsd: usd(10) }));
    expect(d.avgCostPerCallMicroUsd).toBe(Math.round(usd(10) / 100));
    expect(d.avgTokensPerCall).toBe(Math.round(75_000 / 100));
  });

  it('never divides by zero on an idle or wholly failing project', () => {
    const idle = deriveAiStats(stats({ totalCalls: 0, errorCalls: 0, totalCostMicroUsd: 0 }));
    expect(idle).toMatchObject({ errorRatePct: 0, avgCostPerCallMicroUsd: 0, avgTokensPerCall: 0 });

    const allFailed = deriveAiStats(stats({ totalCalls: 10, errorCalls: 10, totalCostMicroUsd: 0 }));
    expect(allFailed.errorRatePct).toBe(100);
    expect(allFailed.avgCostPerCallMicroUsd).toBe(0);
  });
});

describe('AI share calculations', () => {
  it('reports the top caller share and ignores unattributed spend', () => {
    expect(topUserSharePct([user({ userHash: 'u_a', costMicroUsd: 900 }), user({ userHash: 'u_b', costMicroUsd: 100 })])).toBe(90);
    expect(topUserSharePct([user({ userHash: null, costMicroUsd: 9999 }), user({ userHash: 'u_a', costMicroUsd: 10 })])).toBe(100);
    expect(topUserSharePct([])).toBeNull();
  });

  it('reports each model as a share of total spend', () => {
    const models = [model({ model: 'gpt-4o', costMicroUsd: usd(3) }), model({ model: 'gpt-4o-mini', costMicroUsd: usd(1) })];
    expect(modelSharePct(models[0]!, models)).toBe(75);
    expect(modelSharePct(models[1]!, models)).toBe(25);
    expect(modelSharePct(model({ costMicroUsd: 0 }), [model({ costMicroUsd: 0 })])).toBe(0);
  });
});

describe('AI error descriptions', () => {
  it('gives every failure kind a label and an action', () => {
    for (const kind of ['ceiling', 'rate_limit', 'auth', 'bad_request', 'timeout', 'server_error', 'network', 'unknown']) {
      expect(ERROR_KIND_LABEL[kind], kind).toBeTruthy();
      expect(ERROR_KIND_HINT[kind]!.length, kind).toBeGreaterThan(20);
    }
  });

  it('describes a ceiling refusal as the firewall working, not as a fault', () => {
    const [described] = describeErrors([{ errorKind: 'ceiling', calls: 7 }]);
    expect(described?.label).toContain('spend ceiling');
    expect(described?.hint).toContain('refused these before they reached the provider');
  });

  it('falls back to the unknown label for a kind it has never seen', () => {
    const [described] = describeErrors([{ errorKind: 'something_new', calls: 1 }]);
    expect(described?.label).toBe(ERROR_KIND_LABEL.unknown);
  });
});

describe('AI formatting', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
    expect(formatTokens(430)).toBe('430');
    expect(formatTokens(5_400)).toBe('5.4k');
    expect(formatTokens(54_000)).toBe('54k');
    expect(formatTokens(2_400_000)).toBe('2.4M');
    // 1.65 is not exactly representable as a float, so toFixed rounds down here.
    // Worth pinning: a token count that drifts by a rounding step is still fine,
    // one that drifts by an order of magnitude is not.
    expect(formatTokens(1_650_000)).toBe('1.6M');
  });

  it('formats latency in the unit a reader expects', () => {
    expect(formatLatency(0)).toBe('—');
    expect(formatLatency(320)).toBe('320ms');
    expect(formatLatency(1800)).toBe('1.8s');
  });
});

describe('AI spend alert email', () => {
  const base = {
    projectLabel: 'my-saas.com',
    windowMicroUsd: usd(0.75),
    windowMinutes: 15,
    topModels: [model({ model: 'gpt-4o', costMicroUsd: usd(2.8), calls: 40, errors: 3 })],
    topUsers: [user({ userHash: 'abc123def456789', costMicroUsd: usd(2.9), calls: 42 })],
  };

  it('names the multiple, the model and the caller for a baseline spike', () => {
    const verdict = evaluateVelocity({ windowMicroUsd: usd(0.75), windowMinutes: 15, ceilingMicroUsd: null, baselineMicroUsd: usd(0.05) });
    const email = buildSpendAlertEmail({ ...base, verdict, ceilingMicroUsd: null, baselineMicroUsd: usd(0.05) });

    expect(email.subject).toContain('my-saas.com');
    expect(email.subject).toContain('× normal');
    // The whole point: the alert says what to look at, not "open the dashboard".
    expect(email.text).toContain('gpt-4o');
    expect(email.text).toContain('abc123def456');
    expect(email.text).toContain('3 failed');
    expect(email.text).toMatch(/retry loop|runaway job/);
  });

  it('names the threshold and the percentage when a ceiling is set', () => {
    const verdict = evaluateVelocity({ windowMicroUsd: usd(2.5), windowMinutes: 15, ceilingMicroUsd: usd(10) });
    const email = buildSpendAlertEmail({ ...base, verdict, ceilingMicroUsd: usd(10), baselineMicroUsd: null });

    expect(email.subject).toContain('% of your threshold');
    expect(email.text).toContain('$10.00/hour threshold');
    expect(describeReason({ ...base, verdict, ceilingMicroUsd: usd(10), baselineMicroUsd: null })).toContain('100%');
  });

  it('escalates the marker for a critical verdict', () => {
    const warning = evaluateVelocity({ windowMicroUsd: usd(2), windowMinutes: 15, ceilingMicroUsd: usd(10) });
    const critical = evaluateVelocity({ windowMicroUsd: usd(5), windowMinutes: 15, ceilingMicroUsd: usd(10) });
    expect(buildSpendAlertEmail({ ...base, verdict: warning, ceilingMicroUsd: usd(10), baselineMicroUsd: null }).subject).toContain('💸');
    expect(buildSpendAlertEmail({ ...base, verdict: critical, ceilingMicroUsd: usd(10), baselineMicroUsd: null }).subject).toContain('🚨');
  });

  it('does not accuse a single caller when spend is spread across several', () => {
    const verdict = evaluateVelocity({ windowMicroUsd: usd(3), windowMinutes: 15, ceilingMicroUsd: usd(10) });
    const email = buildSpendAlertEmail({
      ...base,
      verdict,
      ceilingMicroUsd: usd(10),
      baselineMicroUsd: null,
      topUsers: [
        user({ userHash: 'u_a', costMicroUsd: usd(1) }),
        user({ userHash: 'u_b', costMicroUsd: usd(1) }),
        user({ userHash: 'u_c', costMicroUsd: usd(1) }),
      ],
    });
    expect(email.text).not.toMatch(/retry loop|runaway job/);
  });

  it('survives a project with no attribution and no model data', () => {
    const verdict = evaluateVelocity({ windowMicroUsd: usd(3), windowMinutes: 15, ceilingMicroUsd: usd(10) });
    const email = buildSpendAlertEmail({
      ...base,
      verdict,
      ceilingMicroUsd: usd(10),
      baselineMicroUsd: null,
      topModels: [],
      topUsers: [user({ userHash: null, costMicroUsd: 0 })],
    });
    expect(email.subject).toBeTruthy();
    expect(email.text).toContain('Last 15 minutes');
    expect(email.text).not.toContain('undefined');
  });

  it('includes the dashboard link when one can be built', () => {
    const verdict = evaluateVelocity({ windowMicroUsd: usd(3), windowMinutes: 15, ceilingMicroUsd: usd(10) });
    const withLink = buildSpendAlertEmail({
      ...base,
      verdict,
      ceilingMicroUsd: usd(10),
      baselineMicroUsd: null,
      dashboardUrl: 'https://app.test/runtime/ai?projectId=p1',
    });
    expect(withLink.text).toContain('https://app.test/runtime/ai?projectId=p1');
    expect(buildSpendAlertEmail({ ...base, verdict, ceilingMicroUsd: usd(10), baselineMicroUsd: null }).text).not.toContain('http');
  });
});

describe('AI error kinds — one closed set, three declarations', () => {
  /**
   * The set is spelled out in the SDK (which produces the label), in the db
   * package (which types the column) and in the ingest route (whose allowlist
   * is the security boundary). Each is local on purpose — the route's
   * allowlist should be readable in the file that enforces it — so drift is
   * pinned here instead.
   */
  it('agrees across the SDK, the database types and the ingest allowlist', () => {
    const sdk = [...SDK_ERROR_KINDS].sort();
    expect([...DB_ERROR_KINDS].sort()).toEqual(sdk);
    expect([...ALLOWED_AI_ERROR_KINDS].sort()).toEqual(sdk);
  });

  it('has a label and a hint for every member, so the console can never render a bare slug', () => {
    for (const kind of SDK_ERROR_KINDS) {
      expect(ERROR_KIND_LABEL[kind], kind).toBeTruthy();
      expect(ERROR_KIND_HINT[kind], kind).toBeTruthy();
    }
  });
});

/**
 * Demo telemetry.
 *
 * Every row produced here is written with `source: 'sample'`, which every
 * spend query filters out, so a demo can never move a number a bill depends
 * on. The scenarios are fixed rather than parameterised from the client: this
 * writes rows into the same table as production telemetry, and free-form input
 * on that path is an injection surface with no upside.
 *
 * Deterministic on purpose — a demo that produces different numbers each click
 * cannot be reasoned about, and the shapes here are chosen to exercise every
 * panel the console renders: a cheap model and an expensive one, attributed and
 * unattributed calls, and both kinds of failure.
 */

import type { AiErrorKind } from '@scanlyfix/db';

export const SAMPLE_SCENARIOS = ['mixed', 'runaway', 'failing'] as const;
export type SampleScenario = (typeof SAMPLE_SCENARIOS)[number];

export function isSampleScenario(value: string): value is SampleScenario {
  return (SAMPLE_SCENARIOS as ReadonlyArray<string>).includes(value);
}

export const SAMPLE_SCENARIO_LABEL: Readonly<Record<SampleScenario, string>> = {
  mixed: 'Typical traffic',
  runaway: 'Runaway loop',
  failing: 'Failing calls',
};

export const SAMPLE_SCENARIO_HINT: Readonly<Record<SampleScenario, string>> = {
  mixed: 'A handful of calls across two models and two users.',
  runaway: 'One user hammering an expensive model — what a loop looks like.',
  failing: 'Rate limits, an auth rejection and a ceiling refusal.',
};

export type SampleCallSpec = {
  provider: 'openai' | 'anthropic';
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  userHash: string;
  status: 'ok' | 'error' | null;
  errorKind: AiErrorKind | null;
};

const ok = (
  provider: SampleCallSpec['provider'],
  model: string,
  promptTokens: number,
  completionTokens: number,
  latencyMs: number,
  userHash: string,
): SampleCallSpec => ({ provider, model, promptTokens, completionTokens, latencyMs, userHash, status: null, errorKind: null });

const failed = (
  provider: SampleCallSpec['provider'],
  model: string,
  latencyMs: number,
  userHash: string,
  errorKind: AiErrorKind,
): SampleCallSpec => ({ provider, model, promptTokens: 0, completionTokens: 0, latencyMs, userHash, status: 'error', errorKind });

const USER_A = 'sample_user_alpha';
const USER_B = 'sample_user_beta';

export function buildSampleCalls(scenario: SampleScenario): SampleCallSpec[] {
  switch (scenario) {
    case 'runaway':
      // One caller, one expensive model, tight latencies — the retry-loop shape.
      return Array.from({ length: 12 }, (_, i) => ok('openai', 'gpt-4o', 4000, 900, 400 + i * 5, USER_A));

    case 'failing':
      return [
        ok('openai', 'gpt-4o-mini', 500, 150, 320, USER_A),
        failed('openai', 'gpt-4o-mini', 180, USER_A, 'rate_limit'),
        failed('openai', 'gpt-4o-mini', 140, USER_A, 'rate_limit'),
        failed('anthropic', 'claude-3-5-sonnet', 95, USER_B, 'auth'),
        failed('openai', 'gpt-4o', 4, USER_B, 'ceiling'),
      ];

    case 'mixed':
    default:
      return [
        ok('openai', 'gpt-4o-mini', 420, 130, 280, USER_A),
        ok('openai', 'gpt-4o-mini', 610, 210, 340, USER_A),
        ok('openai', 'gpt-4o', 1200, 480, 910, USER_B),
        ok('anthropic', 'claude-3-5-sonnet', 980, 350, 1240, USER_B),
        ok('anthropic', 'claude-3-5-haiku', 350, 120, 260, USER_A),
        failed('openai', 'gpt-4o', 210, USER_B, 'rate_limit'),
      ];
  }
}

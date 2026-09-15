/**
 * Building and queueing an AI telemetry event.
 *
 * Shared by both wrappers because the rules are the wrappers' contract, not
 * OpenAI's or Anthropic's:
 *
 *   - Cost is recomputed server-side on ingest. The figure attached here is the
 *     same one the local firewall used, so the number that trips a ceiling and
 *     the number on screen come from one function.
 *   - A failed call reports zero tokens and zero cost. A rejected request was
 *     not billed, and inventing spend to fill a chart would corrupt the only
 *     number the ceiling trusts.
 *   - Reporting can never be the reason a call fails.
 */

import type { AiCallEvent, RuntimeClient } from '../runtime.ts';
import { classifyAiError } from './error-kind.ts';
import { estimateCostMicroUsd } from './pricing.ts';

export type AiProvider = 'openai' | 'anthropic';

export function makeSuccessEvent(params: {
  provider: AiProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  userIdHash: string | null;
}): AiCallEvent {
  return {
    type: 'ai_call',
    provider: params.provider,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    latencyMs: params.latencyMs,
    costMicroUsd: estimateCostMicroUsd(params.model, params.promptTokens, params.completionTokens),
    userHash: params.userIdHash ?? undefined,
    status: 'ok',
  };
}

/**
 * A failed call still happened, and an error rate is one of the few numbers
 * that tells a developer their AI integration is broken rather than merely
 * expensive. The label is a closed-set value; the provider's message — which
 * can echo prompt content back — is never recorded.
 */
export function makeErrorEvent(params: {
  provider: AiProvider;
  model: string;
  latencyMs: number;
  userIdHash: string | null;
  error: unknown;
}): AiCallEvent {
  return {
    type: 'ai_call',
    provider: params.provider,
    model: params.model,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: params.latencyMs,
    costMicroUsd: 0,
    userHash: params.userIdHash ?? undefined,
    status: 'error',
    errorKind: classifyAiError(params.error),
  };
}

/** Queue an event and kick the flush. Every failure mode is swallowed. */
export function safeReport(runtime: RuntimeClient, event: AiCallEvent): void {
  try {
    runtime.report(event);
    const flushed = runtime.flush();
    if (flushed && typeof flushed.catch === 'function') void flushed.catch(() => {});
  } catch {
    /* telemetry is never load-bearing */
  }
}

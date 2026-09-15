import type { RuntimeClient } from '../runtime.ts';
import { hashUserId } from './hash.ts';
import { makeErrorEvent, makeSuccessEvent, safeReport } from './report.ts';
import { estimateCostMicroUsd } from './pricing.ts';
import { estimateProjectedCost, estimatePromptTokens } from './estimate.ts';
import type { SpendFirewall } from './spend-firewall.ts';

export interface AnthropicClientLike {
  messages: { create: (args: Record<string, unknown>) => Promise<unknown> };
}

export type AnthropicGuardOptions = {
  runtime: RuntimeClient;
  firewall?: SpendFirewall;
  getUserId?: () => string | undefined;
};

type CallArgs = {
  model: string;
  messages: Array<{ role?: string; content?: unknown }>;
  system?: unknown;
  stream?: boolean;
  max_tokens: number; // Anthropic me REQUIRED — projection ke liye perfect
};

export function wrapAnthropic<T extends AnthropicClientLike>(client: T, opts: AnthropicGuardOptions): T {
  const original = client.messages.create.bind(client.messages) as
    (args: Record<string, unknown>) => Promise<unknown>;

  (client.messages as { create: typeof original }).create = async (rawArgs: Record<string, unknown>) => {
    const args = rawArgs as CallArgs;
    const userId = opts.getUserId?.();
    const userIdHash = userId ? await hashUserId(userId) : null;

    const projected = estimateProjectedCost({
      model: args.model,
      messages: args.messages,
      system: args.system,
      maxOutputTokens: args.max_tokens,
    });
    const start = Date.now();
    try {
      // A refusal is the firewall doing its job; the developer should be able
      // to see how often it happens, so it is reported like any other failure.
      await opts.firewall?.check(projected);
    } catch (e) {
      safeReport(
        opts.runtime,
        makeErrorEvent({ provider: 'anthropic', model: args.model, latencyMs: Date.now() - start, userIdHash, error: e }),
      );
      throw e;
    }

    try {
      if (args.stream) {
        const stream = (await original(rawArgs)) as AsyncIterable<unknown>;
        return instrumentStream(stream, {
          model: args.model,
          fallbackPromptTokens: estimatePromptTokens(args.messages, args.system),
          latencyRef: start,
          userIdHash,
          opts,
          reservedMicroUsd: projected,
        });
      }

      const res = (await original(rawArgs)) as {
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const promptTokens = res.usage?.input_tokens ?? estimatePromptTokens(args.messages, args.system);
      const completionTokens = res.usage?.output_tokens ?? 0;
      safeReport(
        opts.runtime,
        makeSuccessEvent({
          provider: 'anthropic',
          model: res.model ?? args.model,
          promptTokens,
          completionTokens,
          latencyMs: Date.now() - start,
          userIdHash,
        }),
      );
      const exact = estimateCostMicroUsd(args.model, promptTokens, completionTokens);
      if (exact < projected) await opts.firewall?.refund(projected - exact);
      return res;
    } catch (e) {
      await opts.firewall?.refund(projected);
      safeReport(
        opts.runtime,
        makeErrorEvent({ provider: 'anthropic', model: args.model, latencyMs: Date.now() - start, userIdHash, error: e }),
      );
      throw e;
    }
  };

  return client;
}

async function* instrumentStream(
  stream: AsyncIterable<unknown>,
  ctx: {
    model: string;
    fallbackPromptTokens: number;
    latencyRef: number;
    userIdHash: string | null;
    opts: AnthropicGuardOptions;
    reservedMicroUsd: number;
  },
): AsyncGenerator<unknown> {
  let latencyMs = 0;
  let inTok = 0;
  let outTok = 0;
  let failure: unknown = null;
  try {
    for await (const ev of stream) {
      if (latencyMs === 0) latencyMs = Date.now() - ctx.latencyRef;
      // message_start → input_tokens · message_delta → cumulative output_tokens
      const e = ev as {
        type?: string;
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      if (e.type === 'message_start') inTok = e.message?.usage?.input_tokens ?? 0;
      if (e.type === 'message_delta') outTok = e.usage?.output_tokens ?? outTok;
      yield ev; // ⭐ events untouched
    }
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    // ⭐ abandon ho ya complete — report + refund HAMESHA honge
    const promptTokens = inTok || ctx.fallbackPromptTokens;
    const elapsed = latencyMs || Date.now() - ctx.latencyRef;

    // A stream that broke mid-flight still consumed the tokens the provider
    // will bill, so the delivered part is reported at its real cost and the
    // failure is recorded separately at zero cost for the error rate.
    safeReport(
      ctx.opts.runtime,
      makeSuccessEvent({
        provider: 'anthropic',
        model: ctx.model,
        promptTokens,
        completionTokens: outTok,
        latencyMs: elapsed,
        userIdHash: ctx.userIdHash,
      }),
    );
    if (failure !== null) {
      safeReport(
        ctx.opts.runtime,
        makeErrorEvent({ provider: 'anthropic', model: ctx.model, latencyMs: elapsed, userIdHash: ctx.userIdHash, error: failure }),
      );
    }
    const exact = estimateCostMicroUsd(ctx.model, promptTokens, outTok);
    if (exact < ctx.reservedMicroUsd) await ctx.opts.firewall?.refund(ctx.reservedMicroUsd - exact);
  }
}
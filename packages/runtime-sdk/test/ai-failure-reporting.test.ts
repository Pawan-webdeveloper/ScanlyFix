/**
 * A failed AI call used to be invisible: the wrappers refunded the firewall
 * reservation and rethrew without reporting, so a project whose calls were all
 * failing looked identical to one making none.
 */
import { describe, expect, it, vi } from 'vitest';

import type { AiCallEvent } from '../src/runtime.ts';
import { createRuntime, type RuntimeClient } from '../src/runtime.ts';
import { MemorySpendStore, SpendCeilingError, SpendFirewall } from '../src/ai/spend-firewall.ts';
import { wrapAnthropic } from '../src/ai/wrap-anthropic.ts';
import { wrapOpenAI } from '../src/ai/wrap-openai.ts';

function makeRuntime(): { runtime: RuntimeClient; events: AiCallEvent[] } {
  const events: AiCallEvent[] = [];
  const runtime = createRuntime({ projectId: 'p', ingestUrl: 'http://localhost/api/runtime/ingest' });
  vi.spyOn(runtime, 'report').mockImplementation((e) => {
    events.push(e as AiCallEvent);
  });
  vi.spyOn(runtime, 'flush').mockResolvedValue();
  return { runtime, events };
}

const openAiClient = (create: (args: Record<string, unknown>) => Promise<unknown>) => ({
  chat: { completions: { create } },
});
const anthropicClient = (create: (args: Record<string, unknown>) => Promise<unknown>) => ({ messages: { create } });

const CHAT = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] };
const MSG = { model: 'claude-3-5-sonnet', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] };

describe('wrapOpenAI — failures are reported', () => {
  it('records a rate limit at zero cost and rethrows the original error', async () => {
    const { runtime, events } = makeRuntime();
    const boom = Object.assign(new Error('rate limited'), { status: 429 });
    const client = wrapOpenAI(openAiClient(vi.fn().mockRejectedValue(boom)), { runtime });

    await expect(client.chat.completions.create(CHAT)).rejects.toBe(boom);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'ai_call',
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'error',
      errorKind: 'rate_limit',
      // A rejected request was never billed. Inventing spend here would corrupt
      // the only number the ceiling is judged against.
      costMicroUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
  });

  it('records a firewall refusal, which happens before the provider is called', async () => {
    const { runtime, events } = makeRuntime();
    const create = vi.fn();
    const firewall = new SpendFirewall({ projectId: 'p', store: new MemorySpendStore(), ceilingUsdPerHour: 0.000001 });
    const client = wrapOpenAI(openAiClient(create), { runtime, firewall });

    await expect(client.chat.completions.create(CHAT)).rejects.toBeInstanceOf(SpendCeilingError);

    expect(create).not.toHaveBeenCalled(); // the whole point of the firewall
    expect(events[0]).toMatchObject({ status: 'error', errorKind: 'ceiling', costMicroUsd: 0 });
  });

  it('marks a successful call explicitly, so an absent status can mean "old SDK"', async () => {
    const { runtime, events } = makeRuntime();
    const client = wrapOpenAI(
      openAiClient(vi.fn().mockResolvedValue({ model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 50 } })),
      { runtime },
    );

    await client.chat.completions.create(CHAT);
    expect(events[0]).toMatchObject({ status: 'ok', promptTokens: 100, completionTokens: 50 });
    expect(events[0]?.errorKind).toBeUndefined();
    expect(events[0]?.costMicroUsd).toBeGreaterThan(0);
  });

  it('reports the delivered part AND the failure when a stream breaks mid-flight', async () => {
    const { runtime, events } = makeRuntime();
    const boom = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    async function* broken() {
      yield { usage: { prompt_tokens: 80, completion_tokens: 20 } };
      throw boom;
    }
    const client = wrapOpenAI(openAiClient(vi.fn().mockResolvedValue(broken())), { runtime });

    const stream = (await client.chat.completions.create({ ...CHAT, stream: true })) as AsyncIterable<unknown>;
    await expect(
      (async () => {
        for await (const _ of stream) {
          /* drain */
        }
      })(),
    ).rejects.toBe(boom);

    // The tokens the provider already billed are still accounted for…
    const success = events.find((e) => e.status === 'ok');
    expect(success).toMatchObject({ promptTokens: 80, completionTokens: 20 });
    // …and the failure is visible to the error rate.
    expect(events.find((e) => e.status === 'error')).toMatchObject({ errorKind: 'network', costMicroUsd: 0 });
  });

  it('never lets a telemetry failure break the call', async () => {
    const runtime = createRuntime({ projectId: 'p', ingestUrl: 'http://localhost/api/runtime/ingest' });
    vi.spyOn(runtime, 'report').mockImplementation(() => {
      throw new Error('queue exploded');
    });
    vi.spyOn(runtime, 'flush').mockResolvedValue();
    const client = wrapOpenAI(openAiClient(vi.fn().mockResolvedValue({ usage: { prompt_tokens: 1, completion_tokens: 1 } })), {
      runtime,
    });

    await expect(client.chat.completions.create(CHAT)).resolves.toBeDefined();
  });

  it('never lets a rejected flush surface as an unhandled rejection', async () => {
    const runtime = createRuntime({ projectId: 'p', ingestUrl: 'http://localhost/api/runtime/ingest' });
    vi.spyOn(runtime, 'report').mockImplementation(() => {});
    vi.spyOn(runtime, 'flush').mockReturnValue(Promise.reject(new Error('ingest down')));
    const client = wrapOpenAI(openAiClient(vi.fn().mockResolvedValue({ usage: {} })), { runtime });

    await expect(client.chat.completions.create(CHAT)).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('wrapAnthropic — failures are reported', () => {
  it('records an auth rejection at zero cost and rethrows', async () => {
    const { runtime, events } = makeRuntime();
    const boom = Object.assign(new Error('invalid key'), { status: 401 });
    const client = wrapAnthropic(anthropicClient(vi.fn().mockRejectedValue(boom)), { runtime });

    await expect(client.messages.create(MSG)).rejects.toBe(boom);
    expect(events[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      status: 'error',
      errorKind: 'auth',
      costMicroUsd: 0,
    });
  });

  it('records a firewall refusal without calling the provider', async () => {
    const { runtime, events } = makeRuntime();
    const create = vi.fn();
    const firewall = new SpendFirewall({ projectId: 'p', store: new MemorySpendStore(), ceilingUsdPerHour: 0.000001 });
    const client = wrapAnthropic(anthropicClient(create), { runtime, firewall });

    await expect(client.messages.create(MSG)).rejects.toBeInstanceOf(SpendCeilingError);
    expect(create).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ status: 'error', errorKind: 'ceiling' });
  });

  it('marks a success and keeps reading usage from the stream events', async () => {
    const { runtime, events } = makeRuntime();
    async function* stream() {
      yield { type: 'message_start', message: { usage: { input_tokens: 120 } } };
      yield { type: 'message_delta', usage: { output_tokens: 60 } };
    }
    const client = wrapAnthropic(anthropicClient(vi.fn().mockResolvedValue(stream())), { runtime });

    const out = (await client.messages.create({ ...MSG, stream: true })) as AsyncIterable<unknown>;
    const seen: unknown[] = [];
    for await (const ev of out) seen.push(ev);

    // Events reach the caller untouched.
    expect(seen).toHaveLength(2);
    expect(events[0]).toMatchObject({ status: 'ok', promptTokens: 120, completionTokens: 60 });
  });

  it('reports both halves when an Anthropic stream breaks', async () => {
    const { runtime, events } = makeRuntime();
    const boom = Object.assign(new Error('overloaded'), { status: 529 });
    async function* broken() {
      yield { type: 'message_start', message: { usage: { input_tokens: 50 } } };
      throw boom;
    }
    const client = wrapAnthropic(anthropicClient(vi.fn().mockResolvedValue(broken())), { runtime });

    const out = (await client.messages.create({ ...MSG, stream: true })) as AsyncIterable<unknown>;
    await expect(
      (async () => {
        for await (const _ of out) {
          /* drain */
        }
      })(),
    ).rejects.toBe(boom);

    expect(events.find((e) => e.status === 'ok')).toMatchObject({ promptTokens: 50 });
    expect(events.find((e) => e.status === 'error')).toMatchObject({ errorKind: 'server_error' });
  });
});

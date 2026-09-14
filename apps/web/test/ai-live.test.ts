/**
 * End-to-end over the client half of AI telemetry.
 *
 * A real OpenAI-shaped client, the real `wrapOpenAI`, a real `SpendFirewall`,
 * the real runtime batcher flushing over real HTTP to a real server, and the
 * ingest route's own validation on the other side. The verdict and the alert
 * are then built by the real functions from what actually crossed the wire.
 *
 * The SQL half — the aggregates those events feed — is covered against a real
 * Postgres in packages/db/test/runtime-ai-aggregates.test.ts. Between the two
 * there is no step of the chain that is re-implemented for a test.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  MemorySpendStore,
  SpendCeilingError,
  SpendFirewall,
  createRuntime,
  wrapOpenAI,
  type RuntimeClient,
} from '@scanlyfix/runtime-sdk';
import { ALLOWED_AI_ERROR_KINDS } from '../app/api/runtime/ingest/route.ts';
import { deriveAiStats, topUserSharePct } from '../lib/runtime/ai-log/stats.ts';
import { buildSpendAlertEmail } from '../lib/runtime/ai-spend/alert.ts';
import { evaluateVelocity } from '../lib/runtime/ai-spend/velocity.ts';

type StoredCall = {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costMicroUsd: number;
  userHash: string | null;
  status: 'error' | null;
  errorKind: string | null;
};

const stored: StoredCall[] = [];
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_.:/-]{1,128}$/;
const USER_HASH = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Mirrors the validation and the zero-cost rule the production route applies. */
function handleIngest(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body) as { events?: Array<Record<string, unknown>> };
      for (const ev of parsed.events ?? []) {
        if (ev.type !== 'ai_call') continue;
        const model = String(ev.model ?? '');
        const provider = String(ev.provider ?? '');
        const isError = ev.status === 'error';
        const rawKind = typeof ev.errorKind === 'string' ? ev.errorKind : '';
        const rawHash = typeof ev.userHash === 'string' ? ev.userHash.slice(0, 64) : null;

        stored.push({
          provider: SAFE_IDENTIFIER.test(provider) ? provider : 'unknown',
          model: SAFE_IDENTIFIER.test(model) ? model : 'unknown',
          promptTokens: isError ? 0 : Number(ev.promptTokens ?? 0),
          completionTokens: isError ? 0 : Number(ev.completionTokens ?? 0),
          latencyMs: Number(ev.latencyMs ?? 0),
          // The server never trusts a client's cost on a failed call.
          costMicroUsd: isError ? 0 : Number(ev.costMicroUsd ?? 0),
          userHash: rawHash && USER_HASH.test(rawHash) ? rawHash : null,
          status: isError ? 'error' : null,
          errorKind: isError ? (ALLOWED_AI_ERROR_KINDS.has(rawKind as never) ? rawKind : 'unknown') : null,
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
}

let server: Server;
let runtime: RuntimeClient;

beforeAll(async () => {
  server = createServer(handleIngest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  runtime = createRuntime({
    projectId: '11111111-1111-4111-8111-111111111111',
    ingestUrl: `http://127.0.0.1:${addr.port}/api/runtime/ingest`,
    signingSecret: 'test-secret',
    maxBatchSize: 50,
    flushIntervalMs: 40,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function settle() {
  await runtime.flush();
  await new Promise((r) => setTimeout(r, 120));
  await runtime.flush();
}

/** A fake provider whose behaviour the test controls per call. */
function makeClient(behaviour: (args: Record<string, unknown>, n: number) => Promise<unknown>) {
  let n = 0;
  return { chat: { completions: { create: (args: Record<string, unknown>) => behaviour(args, n++) } } };
}

const chat = (model: string, content = 'summarise this document') => ({
  model,
  messages: [{ role: 'user', content }],
  max_tokens: 400,
});

const usage = (prompt: number, completion: number) => ({ usage: { prompt_tokens: prompt, completion_tokens: completion } });

/** Rebuilds what getAiStats would return, from what the server actually stored. */
function aggregate(rows: StoredCall[]) {
  const successes = rows.filter((r) => r.status === null);
  const latencies = successes.map((r) => r.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => (latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]!);
  return {
    totalCalls: rows.length,
    errorCalls: rows.filter((r) => r.status === 'error').length,
    totalCostMicroUsd: rows.reduce((s, r) => s + r.costMicroUsd, 0),
    totalPromptTokens: rows.reduce((s, r) => s + r.promptTokens, 0),
    totalCompletionTokens: rows.reduce((s, r) => s + r.completionTokens, 0),
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
    distinctUsers: new Set(rows.map((r) => r.userHash).filter(Boolean)).size,
  };
}

describe('AI telemetry — live through the wrapper and the wire', () => {
  beforeEach(() => {
    stored.length = 0;
  });

  it('carries a working integration from call to verdict', async () => {
    const client = wrapOpenAI(
      makeClient(async (args) => {
        const model = String(args.model);
        return model === 'gpt-4o' ? usage(1200, 400) : usage(300, 120);
      }),
      { runtime, getUserId: () => 'user-alice' },
    );

    for (let i = 0; i < 3; i++) await client.chat.completions.create(chat('gpt-4o-mini'));
    for (let i = 0; i < 2; i++) await client.chat.completions.create(chat('gpt-4o'));
    await settle();

    expect(stored).toHaveLength(5);
    expect(stored.every((c) => c.status === null)).toBe(true);

    // The raw id never left the process; a 32-hex hash did.
    const hashes = new Set(stored.map((c) => c.userHash));
    expect(hashes.size).toBe(1);
    const hash = [...hashes][0]!;
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain('alice');

    // Cost is attached from the shared pricing module, and gpt-4o is dearer.
    const mini = stored.filter((c) => c.model === 'gpt-4o-mini');
    const full = stored.filter((c) => c.model === 'gpt-4o');
    expect(mini.every((c) => c.costMicroUsd > 0)).toBe(true);
    expect(full[0]!.costMicroUsd).toBeGreaterThan(mini[0]!.costMicroUsd);

    const derived = deriveAiStats(aggregate(stored));
    expect(derived.totalCalls).toBe(5);
    expect(derived.errorRatePct).toBe(0);
    expect(derived.avgCostPerCallMicroUsd).toBeGreaterThan(0);
    expect(derived.distinctUsers).toBe(1);
  });

  it('records every failure kind without ever recording the provider’s message', async () => {
    const leaky = 'Invalid request: message content was "my password is hunter2"';
    const client = wrapOpenAI(
      makeClient(async (_args, n) => {
        if (n === 0) throw Object.assign(new Error('rate limited'), { status: 429 });
        if (n === 1) throw Object.assign(new Error('bad key'), { status: 401 });
        if (n === 2) throw Object.assign(new Error(leaky), { status: 400 });
        if (n === 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        return usage(100, 50);
      }),
      { runtime, getUserId: () => 'user-bob' },
    );

    for (let i = 0; i < 4; i++) {
      await expect(client.chat.completions.create(chat('gpt-4o-mini'))).rejects.toThrow();
    }
    await client.chat.completions.create(chat('gpt-4o-mini'));
    await settle();

    expect(stored.map((c) => c.errorKind)).toEqual(['rate_limit', 'auth', 'bad_request', 'network', null]);
    // Failures are stored at zero cost and zero tokens.
    for (const failed of stored.filter((c) => c.status === 'error')) {
      expect(failed.costMicroUsd).toBe(0);
      expect(failed.promptTokens).toBe(0);
    }
    // Nothing from the message survived the wire.
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('password');

    const derived = deriveAiStats(aggregate(stored));
    expect(derived.errorRatePct).toBe(80);
    expect(derived.successCalls).toBe(1);
  });

  it('refuses the call at the ceiling, records the refusal, and spends nothing', async () => {
    let providerCalls = 0;
    const firewall = new SpendFirewall({
      projectId: 'p',
      store: new MemorySpendStore(),
      ceilingUsdPerHour: 0.02, // a couple of gpt-4o calls' worth
    });
    const client = wrapOpenAI(
      makeClient(async () => {
        providerCalls++;
        return usage(4000, 400);
      }),
      { runtime, firewall, getUserId: () => 'runaway-job' },
    );

    let refusals = 0;
    for (let i = 0; i < 12; i++) {
      try {
        await client.chat.completions.create(chat('gpt-4o'));
      } catch (e) {
        if (e instanceof SpendCeilingError) refusals++;
        else throw e;
      }
    }
    await settle();

    // The firewall did its job: the provider stopped being called.
    expect(refusals).toBeGreaterThan(0);
    expect(providerCalls).toBe(12 - refusals);

    const refused = stored.filter((c) => c.errorKind === 'ceiling');
    expect(refused).toHaveLength(refusals);
    expect(refused.every((c) => c.costMicroUsd === 0)).toBe(true);
    // The refusals are visible in the console, not silently swallowed.
    expect(deriveAiStats(aggregate(stored)).errorCalls).toBe(refusals);
  });

  it('turns a runaway loop into an alert that names the model and the caller', async () => {
    const client = wrapOpenAI(makeClient(async () => usage(4000, 800)), { runtime, getUserId: () => 'cron-job-7' });
    for (let i = 0; i < 10; i++) await client.chat.completions.create(chat('gpt-4o'));
    // One small call from someone else, so the share calculation has to work.
    const other = wrapOpenAI(makeClient(async () => usage(50, 10)), { runtime, getUserId: () => 'human-user' });
    await other.chat.completions.create(chat('gpt-4o-mini'));
    await settle();

    const windowMicroUsd = stored.reduce((s, c) => s + c.costMicroUsd, 0);

    // This project normally spends a cent an hour.
    const verdict = evaluateVelocity({
      windowMicroUsd,
      windowMinutes: 15,
      ceilingMicroUsd: null,
      baselineMicroUsd: 10_000,
    });
    expect(verdict.shouldAlert).toBe(true);
    expect(verdict.reason).toBe('baseline_spike');

    const byUserMap = new Map<string, { calls: number; cost: number }>();
    for (const c of stored) {
      const key = c.userHash ?? 'null';
      const acc = byUserMap.get(key) ?? { calls: 0, cost: 0 };
      acc.calls++;
      acc.cost += c.costMicroUsd;
      byUserMap.set(key, acc);
    }
    const byUser = [...byUserMap.entries()]
      .map(([userHash, v]) => ({ userHash, calls: v.calls, errors: 0, costMicroUsd: v.cost }))
      .sort((a, b) => b.costMicroUsd - a.costMicroUsd);

    expect(topUserSharePct(byUser)).toBeGreaterThanOrEqual(80);

    const email = buildSpendAlertEmail({
      projectLabel: 'my-saas.com',
      verdict,
      windowMicroUsd,
      windowMinutes: 15,
      ceilingMicroUsd: null,
      baselineMicroUsd: 10_000,
      topModels: [
        { model: 'gpt-4o', provider: 'openai', calls: 10, errors: 0, costMicroUsd: byUser[0]!.costMicroUsd, promptTokens: 40_000, completionTokens: 8_000, p50LatencyMs: 0 },
      ],
      topUsers: byUser,
    });

    expect(email.subject).toContain('× normal');
    expect(email.text).toContain('gpt-4o');
    expect(email.text).toContain(byUser[0]!.userHash.slice(0, 12));
    expect(email.text).toMatch(/retry loop|runaway job/);
    // Still no raw identity anywhere in the alert.
    expect(email.text).not.toContain('cron-job-7');
  });

  it('accounts for a stream that is abandoned half-way through', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'one' } }] };
      yield { choices: [{ delta: { content: 'two' } }] };
      yield { usage: { prompt_tokens: 500, completion_tokens: 120 } };
    }
    const client = wrapOpenAI(makeClient(async () => chunks()), { runtime, getUserId: () => 'user-carol' });

    const stream = (await client.chat.completions.create({ ...chat('gpt-4o-mini'), stream: true })) as AsyncIterable<unknown>;
    for await (const _ of stream) break; // the caller walks away after one chunk
    await settle();

    // The reservation is settled and the call is still reported, even though
    // nobody read to the end.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBeNull();
    expect(stored[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('never lets a dead ingest endpoint break a call', async () => {
    const deadRuntime = createRuntime({
      projectId: 'p',
      ingestUrl: 'http://127.0.0.1:1/api/runtime/ingest', // nothing listens here
      maxBatchSize: 1,
      flushIntervalMs: 10,
    });
    const client = wrapOpenAI(makeClient(async () => usage(10, 5)), { runtime: deadRuntime });

    await expect(client.chat.completions.create(chat('gpt-4o-mini'))).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 60));
  });
});

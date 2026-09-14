/**
 * AI spend aggregates against a real Postgres.
 *
 *   SCANLYFIX_DB=1 pnpm --filter @scanlyfix/db test
 *
 * These queries cannot be checked with a mocked client: what they get wrong is
 * SQL semantics, not JavaScript. The percentile filters were written as
 * `FILTER (WHERE NOT (status = 'error'))`, and because `status` is NULL on a
 * successful row that predicate evaluates to NULL for every success — the
 * filter matched nothing and p50/p95 read 0ms forever, against a mock and in
 * production alike. Only a real database catches that.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../src/client.ts';
import { organizations, projects, runtimeAiCalls, users } from '../src/schema.ts';
import {
  getAiStats,
  getErrorBreakdown,
  getSpendBaselineMicroUsd,
  getSpendBreakdown,
  getSpendCeilingMicroUsd,
  getSpendHourlyBuckets,
  listSpendWatchProjectIds,
  recordAiCallEvents,
  setSpendCeiling,
  MIN_BASELINE_HOURS,
} from '../src/queries/runtime-ai.ts';

const live = process.env.SCANLYFIX_DB === '1';

const HOUR_MS = 3600_000;

describe.skipIf(!live)('runtime AI aggregates (SCANLYFIX_DB=1)', () => {
  let projectId = '';
  let otherProjectId = '';
  const cleanup: { users: string[]; orgs: string[] } = { users: [], orgs: [] };

  async function makeProject(name: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@ai-agg.test` })
      .returning({ id: users.id });
    const [org] = await db
      .insert(organizations)
      .values({ name, ownerId: user!.id })
      .returning({ id: organizations.id });
    const [project] = await db
      .insert(projects)
      .values({
        name,
        url: `https://${randomUUID().slice(0, 8)}.ai-agg.test`,
        slug: `ai-agg-${randomUUID().slice(0, 12)}`,
        ownerId: user!.id,
        orgId: org!.id,
      })
      .returning({ id: projects.id });
    cleanup.users.push(user!.id);
    cleanup.orgs.push(org!.id);
    return project!.id;
  }

  /** Writes rows directly so createdAt can be placed in the past. */
  async function seed(
    target: string,
    rows: Array<{
      model: string;
      cost: number;
      latency: number;
      user?: string | null;
      hoursAgo?: number;
      status?: 'error';
      errorKind?: string;
      source?: string;
      promptTokens?: number;
      completionTokens?: number;
    }>,
  ): Promise<void> {
    const now = Date.now();
    await db.insert(runtimeAiCalls).values(
      rows.map((r) => ({
        projectId: target,
        provider: r.model.startsWith('claude') ? 'anthropic' : 'openai',
        model: r.model,
        promptTokens: r.promptTokens ?? 100,
        completionTokens: r.completionTokens ?? 50,
        latencyMs: r.latency,
        costMicroUsd: r.cost,
        userHash: r.user === undefined ? 'u_a' : r.user,
        source: r.source ?? null,
        status: r.status ?? null,
        errorKind: r.errorKind ?? null,
        createdAt: new Date(now - (r.hoursAgo ?? 0) * HOUR_MS - 60_000),
      })),
    );
  }

  beforeAll(async () => {
    projectId = await makeProject('ai-agg-primary');
    otherProjectId = await makeProject('ai-agg-other');
  });

  afterAll(async () => {
    if (cleanup.orgs.length > 0) await db.delete(organizations).where(inArray(organizations.id, cleanup.orgs));
    if (cleanup.users.length > 0) await db.delete(users).where(inArray(users.id, cleanup.users));
  });

  it('computes latency percentiles over successful calls only', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await seed(projectId, [
      { model: 'gpt-4o', cost: 500_000, latency: 100 },
      { model: 'gpt-4o', cost: 500_000, latency: 300 },
      { model: 'gpt-4o', cost: 500_000, latency: 900 },
      // Failures resolve in milliseconds and would drag a naive percentile to zero.
      { model: 'gpt-4o', cost: 0, latency: 2, status: 'error', errorKind: 'rate_limit', promptTokens: 0, completionTokens: 0 },
      { model: 'gpt-4o', cost: 0, latency: 3, status: 'error', errorKind: 'ceiling', promptTokens: 0, completionTokens: 0 },
    ]);

    const stats = await getAiStats(projectId, 60);
    expect(stats.totalCalls).toBe(5);
    expect(stats.errorCalls).toBe(2);
    // The regression this test exists for: a NULL-unsafe filter reads 0 here.
    expect(stats.p50LatencyMs).toBe(300);
    expect(stats.p95LatencyMs).toBeGreaterThan(300);
    expect(stats.totalCostMicroUsd).toBe(1_500_000);
  });

  it('keeps sample rows out of every total', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await seed(projectId, [
      { model: 'gpt-4o-mini', cost: 1_000, latency: 200 },
      { model: 'gpt-4o', cost: 99_000_000, latency: 5000, user: 'u_demo', source: 'sample' },
    ]);

    const [stats, breakdown, buckets] = await Promise.all([
      getAiStats(projectId, 60),
      getSpendBreakdown(projectId, 60),
      getSpendHourlyBuckets(projectId, 2),
    ]);

    expect(stats.totalCalls).toBe(1);
    expect(stats.totalCostMicroUsd).toBe(1_000);
    expect(breakdown.byModel.map((m) => m.model)).toEqual(['gpt-4o-mini']);
    expect(breakdown.byUser.some((u) => u.userHash === 'u_demo')).toBe(false);
    expect(buckets.reduce((sum, b) => sum + b.costMicroUsd, 0)).toBe(1_000);
  });

  it('breaks spend down by model and by caller, counting failures separately', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await seed(projectId, [
      { model: 'gpt-4o', cost: 800_000, latency: 400, user: 'u_a' },
      { model: 'gpt-4o', cost: 200_000, latency: 600, user: 'u_b' },
      { model: 'gpt-4o-mini', cost: 5_000, latency: 150, user: 'u_b' },
      { model: 'gpt-4o', cost: 0, latency: 5, user: 'u_b', status: 'error', errorKind: 'rate_limit', promptTokens: 0, completionTokens: 0 },
    ]);

    const { byModel, byUser } = await getSpendBreakdown(projectId, 60);

    // Ordered by spend, so the expensive model is the first thing read.
    expect(byModel[0]?.model).toBe('gpt-4o');
    expect(byModel[0]).toMatchObject({ calls: 3, errors: 1, costMicroUsd: 1_000_000, provider: 'openai' });
    expect(byModel[1]).toMatchObject({ model: 'gpt-4o-mini', calls: 1, errors: 0 });

    expect(byUser[0]).toMatchObject({ userHash: 'u_a', calls: 1, errors: 0, costMicroUsd: 800_000 });
    expect(byUser.find((u) => u.userHash === 'u_b')).toMatchObject({ calls: 3, errors: 1 });
  });

  it('groups failures by kind, worst-first', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await seed(projectId, [
      { model: 'gpt-4o', cost: 0, latency: 4, status: 'error', errorKind: 'rate_limit', promptTokens: 0, completionTokens: 0 },
      { model: 'gpt-4o', cost: 0, latency: 4, status: 'error', errorKind: 'rate_limit', promptTokens: 0, completionTokens: 0 },
      { model: 'gpt-4o', cost: 0, latency: 4, status: 'error', errorKind: 'auth', promptTokens: 0, completionTokens: 0 },
      { model: 'gpt-4o', cost: 100, latency: 200 },
    ]);

    const errors = await getErrorBreakdown(projectId, 60);
    expect(errors[0]).toEqual({ errorKind: 'rate_limit', calls: 2 });
    expect(errors[1]).toEqual({ errorKind: 'auth', calls: 1 });
  });

  it('takes the baseline as a median over hours that had traffic, ignoring the current hour', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    // Eight past hours at a steady $0.10, plus a huge current hour that must be
    // excluded — the current hour is the one under suspicion.
    const rows = Array.from({ length: 8 }, (_, i) => ({ model: 'gpt-4o-mini', cost: 100_000, latency: 200, hoursAgo: i + 1 }));
    rows.push({ model: 'gpt-4o', cost: 50_000_000, latency: 900, hoursAgo: 0 });
    await seed(projectId, rows);

    expect(await getSpendBaselineMicroUsd(projectId, 7)).toBe(100_000);
  });

  it('offers no baseline until there is enough history to have a normal', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await seed(
      projectId,
      Array.from({ length: MIN_BASELINE_HOURS - 1 }, (_, i) => ({ model: 'gpt-4o', cost: 100_000, latency: 200, hoursAgo: i + 1 })),
    );
    expect(await getSpendBaselineMicroUsd(projectId, 7)).toBeNull();
  });

  it('watches only projects that actually spent something recently', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, otherProjectId));

    // This used to select every project in the database, so the five-minute
    // cron ran three queries per project for a fleet that was mostly idle.
    expect(await listSpendWatchProjectIds(30)).not.toContain(projectId);

    await seed(projectId, [{ model: 'gpt-4o', cost: 500_000, latency: 300 }]);
    // A free call is not spend, and a sample is not real.
    await seed(otherProjectId, [
      { model: 'gpt-4o', cost: 0, latency: 300 },
      { model: 'gpt-4o', cost: 9_000_000, latency: 300, source: 'sample' },
    ]);

    const watched = await listSpendWatchProjectIds(30);
    expect(watched).toContain(projectId);
    expect(watched).not.toContain(otherProjectId);
  });

  it('round-trips a ceiling, and clearing it', async () => {
    await setSpendCeiling(projectId, 5_000_000);
    expect(await getSpendCeilingMicroUsd(projectId)).toBe(5_000_000);
    await setSpendCeiling(projectId, null);
    expect(await getSpendCeilingMicroUsd(projectId)).toBeNull();
  });

  it('stores a failure at zero cost and zero tokens even if the caller claims otherwise', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await recordAiCallEvents(projectId, [
      {
        provider: 'openai',
        model: 'gpt-4o',
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 40,
        costMicroUsd: 900_000,
        status: 'error',
        errorKind: 'rate_limit',
      },
      { provider: 'openai', model: 'gpt-4o', promptTokens: 10, completionTokens: 5, latencyMs: 40, costMicroUsd: 1_000 },
    ]);

    const stats = await getAiStats(projectId, 60);
    expect(stats.errorCalls).toBe(1);
    // The claimed $0.90 on the failed call is discarded by the server.
    expect(stats.totalCostMicroUsd).toBe(1_000 + 900_000);

    const rows = await db.select().from(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    const failed = rows.find((r) => r.status === 'error');
    expect(failed?.errorKind).toBe('rate_limit');
    const succeeded = rows.find((r) => r.status === null);
    expect(succeeded?.errorKind).toBeNull();
  });

  it('never leaks one project’s spend into another’s totals', async () => {
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, projectId));
    await db.delete(runtimeAiCalls).where(eq(runtimeAiCalls.projectId, otherProjectId));
    await seed(projectId, [{ model: 'gpt-4o', cost: 111_000, latency: 200 }]);
    await seed(otherProjectId, [{ model: 'gpt-4o', cost: 999_000, latency: 200 }]);

    expect((await getAiStats(projectId, 60)).totalCostMicroUsd).toBe(111_000);
    expect((await getAiStats(otherProjectId, 60)).totalCostMicroUsd).toBe(999_000);
  });
});

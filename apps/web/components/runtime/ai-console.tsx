'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { AiErrorBreakdown, AiModelBreakdown, AiStats, AiUserBreakdown, HourlySpendBucket } from '@scanlyfix/db';

import { clearCeilingAction, setCeilingAction } from '@/app/(app)/runtime/ai/actions.ts';
import { formatUsd } from '@/lib/runtime/ai-log/summary.ts';
import {
  deriveAiStats,
  describeErrors,
  formatLatency,
  formatTokens,
  modelSharePct,
  topUserSharePct,
} from '@/lib/runtime/ai-log/stats.ts';
import { MAX_CEILING_USD, MIN_CEILING_USD, suggestedCeilingUsd } from '@/lib/runtime/ai-spend/ceiling.ts';
import { computeHourlyChartLayout } from '@/lib/runtime/ai-spend/chart.ts';
import type { VelocityVerdict } from '@/lib/runtime/ai-spend/velocity.ts';
import { AiSetupCard } from './ai-setup.tsx';

export type AiCallRow = {
  id: string;
  provider?: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number | null;
  costMicroUsd: number | null;
  userHash: string | null;
  source?: string | null;
  status?: string | null;
  errorKind?: string | null;
  createdAt: Date | string;
};

export type AiConsoleProps = {
  projectId: string;
  windowMinutes: number;
  stats: AiStats;
  byModel: AiModelBreakdown[];
  byUser: AiUserBreakdown[];
  errors: AiErrorBreakdown[];
  hourSpendMicroUsd: number;
  projectedHourMicroUsd: number;
  ceilingMicroUsd: number | null;
  baselineMicroUsd: number | null;
  verdict: VelocityVerdict;
  calls: AiCallRow[];
  hourlyBuckets: HourlySpendBucket[];
};

export function AiConsole(props: AiConsoleProps) {
  const derived = useMemo(() => deriveAiStats(props.stats), [props.stats]);
  const topShare = useMemo(() => topUserSharePct(props.byUser), [props.byUser]);
  const hasLiveTelemetry = props.stats.totalCalls > 0;

  return (
    <div className="space-y-6">
      <SpendHeader {...props} topShare={topShare} derived={derived} />
      <CeilingPanel
        projectId={props.projectId}
        ceilingMicroUsd={props.ceilingMicroUsd}
        baselineMicroUsd={props.baselineMicroUsd}
      />

      {props.hourlyBuckets.length > 0 && <SpendHourlyChart buckets={props.hourlyBuckets} />}

      {hasLiveTelemetry ? (
        <>
          <MetricStrip derived={derived} windowMinutes={props.windowMinutes} />
          {props.errors.length > 0 && <ErrorPanel errors={props.errors} totalCalls={derived.totalCalls} />}
          <div className="grid gap-6 lg:grid-cols-2">
            <ModelTable byModel={props.byModel} />
            <UserTable byUser={props.byUser} topShare={topShare} />
          </div>
          <CallLog calls={props.calls} />
          <details className="rounded-xl border border-c-line bg-c-card p-5 shadow-sm">
            <summary className="cursor-pointer text-sm font-medium text-c-ink">Integration snippets &amp; sample data</summary>
            <div className="mt-4">
              <AiSetupCard projectId={props.projectId} hasCalls />
            </div>
          </details>
        </>
      ) : (
        <AiSetupCard projectId={props.projectId} />
      )}
    </div>
  );
}

/* ── Spend hero ─────────────────────────────────────────────────────────── */

function SpendHeader(props: AiConsoleProps & { topShare: number | null; derived: ReturnType<typeof deriveAiStats> }) {
  const { verdict } = props;
  const pct = verdict.pctOfCeiling;
  const isCritical = verdict.severity === 'critical';
  const isAlerting = verdict.shouldAlert;

  const projectionSub =
    verdict.reason === 'baseline_spike' && verdict.baselineMultiple !== null
      ? `${verdict.baselineMultiple}× this project's normal ${formatUsd(props.baselineMicroUsd)}/h`
      : props.ceilingMicroUsd
        ? `Projection ${formatUsd(props.projectedHourMicroUsd)}/h · ceiling ${formatUsd(props.ceilingMicroUsd)}/h`
        : props.baselineMicroUsd
          ? `Projection ${formatUsd(props.projectedHourMicroUsd)}/h · normal ${formatUsd(props.baselineMicroUsd)}/h`
          : `Projection ${formatUsd(props.projectedHourMicroUsd)}/h`;

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <SpendCard
        label="This hour (live)"
        value={formatUsd(props.hourSpendMicroUsd)}
        sub={projectionSub}
        pct={pct !== null ? Math.min(100, pct) : null}
        tone={isAlerting ? (isCritical ? 'bad' : 'warn') : 'default'}
      />
      <SpendCard
        label={`Last ${Math.round(props.windowMinutes / 60)}h`}
        value={formatUsd(props.stats.totalCostMicroUsd)}
        sub={`${props.derived.totalCalls.toLocaleString()} calls · ${formatTokens(props.derived.totalTokens)} tokens`}
      />
      <SpendCard
        label="Top caller share"
        value={props.topShare !== null ? `${props.topShare}%` : '—'}
        sub={
          props.byUser[0]?.userHash
            ? `${props.byUser[0].userHash.slice(0, 12)}… · ${props.byUser[0].calls} calls`
            : 'No user attribution — pass getUserId to the wrapper'
        }
        tone={props.topShare !== null && props.topShare >= 80 ? 'warn' : 'default'}
      />
    </div>
  );
}

function SpendCard({
  label,
  value,
  sub,
  pct,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub?: string;
  pct?: number | null;
  tone?: 'default' | 'warn' | 'bad';
}) {
  const border =
    tone === 'bad' ? 'border-rose-500/40 bg-rose-500/5' : tone === 'warn' ? 'border-amber-500/40 bg-amber-500/5' : 'border-c-line bg-c-card';
  const text =
    tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-c-ink';
  const bar = tone === 'bad' ? 'bg-rose-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-c-accent';

  return (
    <div className={`rounded-xl border p-5 shadow-sm transition-colors ${border}`}>
      <p className="text-xs font-medium uppercase tracking-wider text-c-muted">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${text}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-c-muted">{sub}</p>}
      {pct !== null && pct !== undefined && (
        <div className="mt-3 h-1.5 overflow-hidden rounded bg-c-soft">
          <div className={`h-full rounded transition-all ${bar}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/* ── Secondary metrics ──────────────────────────────────────────────────── */

function MetricStrip({ derived, windowMinutes }: { derived: ReturnType<typeof deriveAiStats>; windowMinutes: number }) {
  const hours = Math.round(windowMinutes / 60);
  const tiles: Array<{ label: string; value: string; hint: string; tone?: 'warn' | 'bad' }> = [
    { label: 'Error rate', value: `${derived.errorRatePct}%`, hint: `${derived.errorCalls} of ${derived.totalCalls} calls failed`, ...(derived.errorRatePct >= 20 ? { tone: 'bad' as const } : derived.errorRatePct >= 5 ? { tone: 'warn' as const } : {}) },
    { label: 'Cost / call', value: formatUsd(derived.avgCostPerCallMicroUsd), hint: 'Mean over successful calls' },
    { label: 'Tokens / call', value: formatTokens(derived.avgTokensPerCall), hint: 'Prompt plus completion' },
    { label: 'Latency p50', value: formatLatency(derived.p50LatencyMs), hint: 'Successful calls only' },
    { label: 'Latency p95', value: formatLatency(derived.p95LatencyMs), hint: 'The slow tail your users feel' },
    { label: 'Callers', value: derived.distinctUsers > 0 ? String(derived.distinctUsers) : '—', hint: `Distinct attributed users in ${hours}h` },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-c-line bg-c-card px-4 py-3 shadow-sm" title={t.hint}>
          <p className="text-[11px] font-medium uppercase tracking-wider text-c-muted">{t.label}</p>
          <p
            className={`mt-1 font-mono text-lg font-semibold ${
              t.tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : t.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-c-ink'
            }`}
          >
            {t.value}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-c-muted">{t.hint}</p>
        </div>
      ))}
    </div>
  );
}

function ErrorPanel({ errors, totalCalls }: { errors: AiErrorBreakdown[]; totalCalls: number }) {
  const described = useMemo(() => describeErrors(errors), [errors]);
  return (
    <section className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-5">
      <h3 className="text-sm font-semibold text-c-ink">Failed calls</h3>
      <p className="mt-0.5 text-xs text-c-muted">
        Failures are recorded at zero cost and zero tokens — a rejected request was never billed.
      </p>
      <ul className="mt-3 space-y-2">
        {described.map((e) => (
          <li key={e.errorKind} className="flex flex-col gap-0.5 border-t border-c-line/60 pt-2 first:border-0 first:pt-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium text-c-ink">{e.label}</span>
              <span className="shrink-0 font-mono text-xs text-c-muted">
                {e.calls} {totalCalls > 0 && <span className="text-[10px]">({Math.round((e.calls / totalCalls) * 100)}%)</span>}
              </span>
            </div>
            <span className="text-[11px] leading-relaxed text-c-muted">{e.hint}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── Breakdowns ─────────────────────────────────────────────────────────── */

function ModelTable({ byModel }: { byModel: AiModelBreakdown[] }) {
  if (byModel.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-xl border border-c-line bg-c-card shadow-sm">
      <div className="border-b border-c-line px-5 py-3">
        <h3 className="text-sm font-semibold text-c-ink">Spend by model</h3>
        <p className="text-xs text-c-muted">Where the bill actually comes from</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-c-line bg-c-soft/60 text-[11px] uppercase tracking-wider text-c-muted">
              <th className="px-4 py-2.5">Model</th>
              <th className="px-4 py-2.5">Cost</th>
              <th className="px-4 py-2.5">Calls</th>
              <th className="px-4 py-2.5">Tokens</th>
              <th className="px-4 py-2.5">p50</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-c-line">
            {byModel.map((m) => {
              const share = modelSharePct(m, byModel);
              return (
                <tr key={`${m.provider}:${m.model}`} className="hover:bg-c-soft/40">
                  <td className="px-4 py-2.5">
                    <p className="font-mono text-xs font-medium text-c-ink">{m.model}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1 w-16 overflow-hidden rounded-full bg-c-soft" aria-hidden>
                        <div className="h-full rounded-full bg-c-accent" style={{ width: `${share}%` }} />
                      </div>
                      <span className="text-[10px] text-c-muted">{share}% of spend</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs font-semibold text-c-ink">{formatUsd(m.costMicroUsd)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-c-muted">
                    {m.calls.toLocaleString()}
                    {m.errors > 0 && <span className="ml-1 text-rose-600 dark:text-rose-400">({m.errors} failed)</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-c-muted">
                    {formatTokens(m.promptTokens + m.completionTokens)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-c-muted">{formatLatency(m.p50LatencyMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserTable({ byUser, topShare }: { byUser: AiUserBreakdown[]; topShare: number | null }) {
  const attributed = byUser.filter((u) => u.userHash !== null);

  if (attributed.length === 0) {
    return (
      <section className="rounded-xl border border-c-line bg-c-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-c-ink">Spend by caller</h3>
        <p className="mt-2 text-xs leading-relaxed text-c-muted">
          No attribution yet. Pass <code className="rounded bg-c-soft px-1 font-mono text-[11px]">getUserId</code> to the wrapper and
          Guard will hash it one-way on your server — the raw id never leaves your process. Without it, a runaway loop cannot be
          traced to the job or user causing it.
        </p>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-c-line bg-c-card shadow-sm">
      <div className="border-b border-c-line px-5 py-3">
        <h3 className="text-sm font-semibold text-c-ink">Spend by caller</h3>
        <p className="text-xs text-c-muted">
          {topShare !== null && topShare >= 80
            ? 'One caller holds most of this spend — the usual signature of a retry loop.'
            : 'One-way hashes; raw ids never leave your process'}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-c-line bg-c-soft/60 text-[11px] uppercase tracking-wider text-c-muted">
              <th className="px-4 py-2.5">Caller</th>
              <th className="px-4 py-2.5">Cost</th>
              <th className="px-4 py-2.5">Calls</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-c-line">
            {attributed.map((u) => (
              <tr key={u.userHash} className="hover:bg-c-soft/40">
                <td className="px-4 py-2.5 font-mono text-xs text-c-ink">{u.userHash?.slice(0, 16)}…</td>
                <td className="px-4 py-2.5 font-mono text-xs font-semibold text-c-ink">{formatUsd(u.costMicroUsd)}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-c-muted">
                  {u.calls.toLocaleString()}
                  {u.errors > 0 && <span className="ml-1 text-rose-600 dark:text-rose-400">({u.errors} failed)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── Ceiling ────────────────────────────────────────────────────────────── */

function CeilingPanel({
  projectId,
  ceilingMicroUsd,
  baselineMicroUsd,
}: {
  projectId: string;
  ceilingMicroUsd: number | null;
  baselineMicroUsd: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  function save(form: FormData) {
    const usd = Number(form.get('ceiling'));
    setMsg(null);
    startTransition(async () => {
      const res = await setCeilingAction(projectId, usd);
      setMsg(res.ok ? { text: res.message ?? 'Saved.' } : { text: res.error, error: true });
      if (res.ok) router.refresh();
    });
  }

  function clear() {
    setMsg(null);
    startTransition(async () => {
      const res = await clearCeilingAction(projectId);
      setMsg(res.ok ? { text: res.message ?? 'Cleared.' } : { text: res.error, error: true });
      if (res.ok) router.refresh();
    });
  }

  const suggested = suggestedCeilingUsd(baselineMicroUsd);

  return (
    <div className="rounded-xl border border-c-line bg-c-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-semibold text-c-ink">Hourly spend ceiling</p>
        <form action={save} className="flex items-center gap-2">
          <span className="text-sm text-c-muted">$</span>
          <input
            name="ceiling"
            type="number"
            step="0.5"
            min={MIN_CEILING_USD}
            max={MAX_CEILING_USD}
            aria-label="Hourly spend ceiling in USD"
            defaultValue={ceilingMicroUsd ? ceilingMicroUsd / 1e6 : suggested}
            className="w-24 rounded-lg border border-c-line bg-c-soft px-2.5 py-1.5 text-sm text-c-ink shadow-sm focus:outline-none focus:ring-1 focus:ring-c-accent"
          />
          <span className="text-sm text-c-muted">/ hour</span>
          <button
            disabled={pending}
            className="rounded-lg bg-c-accent px-3.5 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        </form>
        {ceilingMicroUsd !== null && (
          <button
            type="button"
            onClick={clear}
            disabled={pending}
            className="rounded-lg border border-c-line bg-c-card px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:bg-c-soft hover:text-c-ink disabled:opacity-50"
          >
            Remove
          </button>
        )}
        {msg && (
          <span className={`text-xs font-medium ${msg.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
            {msg.text}
          </span>
        )}
      </div>

      <ul className="mt-3 space-y-1.5 border-t border-c-line pt-3 text-xs text-c-muted">
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-emerald-500">✓</span>
          <span>
            <strong className="text-c-ink">Refused before the provider.</strong> The SDK firewall reserves each call&rsquo;s
            projected cost first; crossing the ceiling throws <code className="font-mono text-[11px]">SpendCeilingError</code> and
            the request is never sent. No money is spent.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-emerald-500">✓</span>
          <span>
            <strong className="text-c-ink">Live, without a redeploy.</strong> The firewall re-reads this value every five minutes.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 text-c-muted">ℹ</span>
          <span>
            {ceilingMicroUsd === null ? (
              baselineMicroUsd ? (
                <>
                  No ceiling set. Alerts compare against this project&rsquo;s own normal of{' '}
                  <strong className="text-c-ink">{formatUsd(baselineMicroUsd)}/hour</strong> and fire on a sustained multiple of it.
                </>
              ) : (
                <>No ceiling set, and not enough history yet for a baseline. Alerts fall back to a flat $10/hour guard.</>
              )
            ) : (
              <>Warning at 80% of the ceiling, once per hour at most.</>
            )}
          </span>
        </li>
      </ul>
    </div>
  );
}

/* ── Chart ──────────────────────────────────────────────────────────────── */

export function SpendHourlyChart({ buckets }: { buckets: HourlySpendBucket[] }) {
  const layout = useMemo(() => computeHourlyChartLayout(buckets), [buckets]);

  return (
    <div className="rounded-xl border border-c-line bg-c-card p-5 shadow-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-c-ink">24-hour spend</h3>
          <p className="text-xs text-c-muted">Hourly, UTC</p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-c-muted">Total: </span>
            <span className="font-semibold text-c-ink">{formatUsd(layout.total24h)}</span>
          </div>
          <div>
            <span className="text-c-muted">Calls: </span>
            <span className="font-semibold text-c-ink">{layout.totalCalls.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-c-muted">Peak hour: </span>
            <span className="font-semibold text-c-ink">{formatUsd(layout.maxCost)}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-x-auto">
        <div className="min-w-[550px]">
          <svg viewBox={`0 0 ${layout.totalWidth} ${layout.height}`} className="h-28 w-full overflow-visible" role="img" aria-label="Hourly AI spend over the last 24 hours">
            <line
              x1="0"
              y1={layout.height - 20}
              x2={layout.totalWidth}
              y2={layout.height - 20}
              className="stroke-c-line"
              strokeDasharray="2,2"
              strokeWidth="1"
            />
            {layout.bars.map((bar) => (
              <g key={bar.hour} className="group">
                <rect
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  rx="3"
                  className={`transition-all duration-200 ${bar.isZero ? 'fill-c-line/40' : 'fill-c-accent hover:opacity-80'}`}
                />
                <title>{bar.tooltip}</title>
                {bar.showLabel && (
                  <text
                    x={bar.x + bar.width / 2}
                    y={layout.height - 4}
                    textAnchor="middle"
                    className="select-none fill-c-muted font-mono text-[10px]"
                  >
                    {bar.displayHour}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}

/* ── Call log ───────────────────────────────────────────────────────────── */

function CallLog({ calls }: { calls: AiCallRow[] }) {
  const [onlyErrors, setOnlyErrors] = useState(false);
  const visible = useMemo(() => (onlyErrors ? calls.filter((c) => c.status === 'error') : calls), [calls, onlyErrors]);
  const errorCount = useMemo(() => calls.filter((c) => c.status === 'error').length, [calls]);
  const sampleCount = useMemo(() => calls.filter((c) => c.source === 'sample').length, [calls]);

  return (
    <div className="overflow-hidden rounded-xl border border-c-line bg-c-card shadow-sm">
      <div className="flex flex-col gap-2 border-b border-c-line px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-c-ink">Recent calls</h3>
            {sampleCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                {sampleCount} sample
              </span>
            )}
          </div>
          <p className="text-xs text-c-muted">Newest {calls.length} calls — metadata only, never prompts or responses</p>
        </div>
        {errorCount > 0 && (
          <button
            type="button"
            onClick={() => setOnlyErrors((v) => !v)}
            className={`self-start rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors sm:self-auto ${
              onlyErrors ? 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400' : 'border-c-line bg-c-soft text-c-ink hover:bg-c-line'
            }`}
          >
            {onlyErrors ? 'Show all' : `Only failures (${errorCount})`}
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-c-line bg-c-soft/60 text-[11px] uppercase tracking-wider text-c-muted">
              <th className="px-4 py-2.5">Time</th>
              <th className="px-4 py-2.5">Model</th>
              <th className="px-4 py-2.5">Tokens in / out</th>
              <th className="px-4 py-2.5">Latency</th>
              <th className="px-4 py-2.5">Cost</th>
              <th className="px-4 py-2.5">Caller</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-c-line">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-xs text-c-muted">
                  No calls match this filter.
                </td>
              </tr>
            ) : (
              visible.map((c) => {
                const failed = c.status === 'error';
                return (
                  <tr key={c.id} className={`transition-colors hover:bg-c-soft/40 ${failed ? 'bg-rose-500/5' : ''}`}>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-c-muted">
                      {new Date(c.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs font-medium text-c-ink">{c.model}</span>
                        <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] capitalize text-c-muted">{c.provider ?? 'openai'}</span>
                        {failed && (
                          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-rose-600 dark:text-rose-400">
                            {c.errorKind ?? 'error'}
                          </span>
                        )}
                        {c.source === 'sample' && (
                          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            sample
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-c-ink">
                      {failed ? '—' : `${c.promptTokens.toLocaleString()} / ${c.completionTokens.toLocaleString()}`}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-c-muted">{formatLatency(c.latencyMs ?? 0)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold text-c-ink">{failed ? '$0.00' : formatUsd(c.costMicroUsd)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-c-muted">{c.userHash ? `${c.userHash.slice(0, 10)}…` : '—'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

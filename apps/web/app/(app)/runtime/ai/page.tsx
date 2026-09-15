import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getAiStats,
  getCurrentHourSpendMicroUsd,
  getErrorBreakdown,
  getSpendBaselineMicroUsd,
  getSpendBreakdown,
  getSpendCeilingMicroUsd,
  getSpendHourlyBuckets,
  listProjects,
  listRecentAiCalls,
} from '@scanlyfix/db';

import { Icon } from '@/components/console/icons.tsx';
import { PageHeader } from '@/components/console/page-header.tsx';
import { AiConsole, type AiCallRow } from '@/components/runtime/ai-console.tsx';
import { getViewer } from '@/lib/authz.ts';
import { hasRuntimeAccess } from '@/lib/entitlements.ts';
import { projectEndOfHourMicroUsd } from '@/lib/runtime/ai-log/summary.ts';
import { evaluateVelocity } from '@/lib/runtime/ai-spend/velocity.ts';

export const metadata = { title: 'Runtime AI Spend & Log — ScanlyFix' };

type ProjectSummary = { id: string; name: string };

/** Windows the console can be scoped to. */
const RANGES = {
  '1h': { minutes: 60, label: 'Last hour' },
  '24h': { minutes: 24 * 60, label: 'Last 24 hours' },
  '7d': { minutes: 7 * 24 * 60, label: 'Last 7 days' },
} as const;
type RangeKey = keyof typeof RANGES;

function parseRange(value: string | undefined): RangeKey {
  return value === '1h' || value === '24h' || value === '7d' ? value : '24h';
}

export default async function AiConsolePage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string; range?: string }>;
}) {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') notFound();

  const projects = await listProjects(viewer);
  const sp = searchParams ? await searchParams : {};
  const activeProject = projects.find((p) => p.id === sp?.projectId) ?? projects[0];
  const range = parseRange(sp?.range);

  if (!activeProject) {
    return (
      <Shell>
        <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-c-ink">No projects under watch</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">
            Add a project from the dashboard to start observing AI spend and token telemetry.
          </p>
          <Link
            href="/dashboard#sites"
            className="mt-6 inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
          >
            Add a domain
          </Link>
        </div>
      </Shell>
    );
  }

  const projectId = activeProject.id;

  const hasAccess = await hasRuntimeAccess(viewer, projectId);
  if (!hasAccess) {
    return (
      <Shell>
        {projects.length > 1 && <ProjectSelector projects={projects} activeProjectId={projectId} range={range} />}
        <GateCard
          title="AI spend & log is a Pro feature"
          body="A wrapper around your AI client, not a proxy: your API key stays in your process, requests go straight to the provider, and only metadata is reported. Spend is projected from a live window so a runaway loop is caught in minutes, and the ceiling refuses calls before they reach the provider."
          cta={{ label: 'Upgrade to Pro', href: '/settings/billing' }}
        />
      </Shell>
    );
  }

  const windowMinutes = RANGES[range].minutes;

  const [stats, breakdown, errors, hourSpend, ceilingMicro, baselineMicro, hourlyBuckets, calls] = await Promise.all([
    getAiStats(projectId, windowMinutes),
    getSpendBreakdown(projectId, windowMinutes),
    getErrorBreakdown(projectId, windowMinutes),
    getCurrentHourSpendMicroUsd(projectId),
    getSpendCeilingMicroUsd(projectId),
    getSpendBaselineMicroUsd(projectId),
    getSpendHourlyBuckets(projectId, 24),
    listRecentAiCalls(projectId, 100),
  ]);

  // Project once, then judge that exact number: passing the projection through
  // as a full hour makes the extrapolation an identity, so the figure on the
  // card and the figure the verdict is based on cannot drift apart.
  const projectedHourMicroUsd = projectEndOfHourMicroUsd(hourSpend);
  const verdict = evaluateVelocity({
    windowMicroUsd: projectedHourMicroUsd,
    windowMinutes: 60,
    ceilingMicroUsd: ceilingMicro,
    baselineMicroUsd: baselineMicro,
  });

  const callRows: AiCallRow[] = calls.map((c) => ({
    id: c.id,
    provider: c.provider,
    model: c.model,
    promptTokens: c.promptTokens,
    completionTokens: c.completionTokens,
    latencyMs: c.latencyMs,
    costMicroUsd: c.costMicroUsd,
    userHash: c.userHash,
    source: c.source,
    status: c.status,
    errorKind: c.errorKind,
    createdAt: c.createdAt,
  }));

  return (
    <Shell>
      {projects.length > 1 && <ProjectSelector projects={projects} activeProjectId={projectId} range={range} />}
      <Subnav projectId={projectId} />

      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-6 items-center rounded-md bg-emerald-500/10 px-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                Active
              </span>
              <h2 className="text-base font-semibold text-c-ink">{activeProject.name}</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-c-muted">
              A client wrapper, not a proxy. Your API keys stay in your process and requests go straight to the provider; only
              metadata is reported. Cost is recomputed server-side from the same pricing table the ceiling uses, so the figure
              that stops a call and the figure on this page are the same figure.
            </p>
          </div>
          <RangeSelector projectId={projectId} active={range} />
        </div>
      </div>

      <AiConsole
        projectId={projectId}
        windowMinutes={windowMinutes}
        stats={stats}
        byModel={breakdown.byModel}
        byUser={breakdown.byUser}
        errors={errors}
        hourSpendMicroUsd={hourSpend}
        projectedHourMicroUsd={projectedHourMicroUsd}
        ceilingMicroUsd={ceilingMicro}
        baselineMicroUsd={baselineMicro}
        verdict={verdict}
        calls={callRows}
        hourlyBuckets={hourlyBuckets}
      />
    </Shell>
  );
}

function RangeSelector({ projectId, active }: { projectId: string; active: RangeKey }) {
  return (
    <div className="flex shrink-0 items-center gap-1 rounded-lg border border-c-line bg-c-card p-0.5 text-[11px]">
      {(Object.keys(RANGES) as RangeKey[]).map((key) => (
        <Link
          key={key}
          href={`/runtime/ai?projectId=${projectId}&range=${key}`}
          className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
            key === active ? 'bg-c-accent text-white' : 'text-c-muted hover:text-c-ink'
          }`}
        >
          {RANGES[key].label}
        </Link>
      ))}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Runtime — AI Spend & Log" />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">{children}</div>
    </div>
  );
}

function Subnav({ projectId }: { projectId: string }) {
  const links = [
    { href: `/runtime?projectId=${projectId}`, label: 'Auth Prober', active: false },
    { href: `/runtime/guard?projectId=${projectId}`, label: 'Guard Routes', active: false },
    { href: `/runtime/ai?projectId=${projectId}`, label: 'AI Spend & Logs', active: true },
    { href: `/runtime/canaries?projectId=${projectId}`, label: 'Canaries', active: false },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-c-line pb-3">
      {links.map((link) =>
        link.active ? (
          <span key={link.href} className="rounded-lg bg-c-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm">
            {link.label}
          </span>
        ) : (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            {link.label}
          </Link>
        ),
      )}
    </div>
  );
}

function ProjectSelector({
  projects,
  activeProjectId,
  range,
}: {
  projects: ProjectSummary[];
  activeProjectId: string;
  range: RangeKey;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-c-line pb-4">
      <span className="text-xs font-medium uppercase tracking-wider text-c-muted">Project:</span>
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`/runtime/ai?projectId=${p.id}&range=${range}`}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            p.id === activeProjectId
              ? 'bg-c-accent text-white shadow-sm'
              : 'border border-c-line bg-c-card text-c-muted hover:border-c-line/80 hover:text-c-ink'
          }`}
        >
          {p.name}
        </Link>
      ))}
    </div>
  );
}

function GateCard({ title, body, cta }: { title: string; body: string; cta: { label: string; href: string } }) {
  return (
    <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <Icon name="shield" size={24} />
      </div>
      <h2 className="text-lg font-semibold text-c-ink">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">{body}</p>
      <Link
        href={cta.href}
        className="mt-6 inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
      >
        {cta.label}
      </Link>
    </div>
  );
}

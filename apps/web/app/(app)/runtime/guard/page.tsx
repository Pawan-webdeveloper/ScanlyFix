import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listGuardRoutes, listProberTargets, listProjects } from '@scanlyfix/db';

import { Icon } from '@/components/console/icons.tsx';
import { PageHeader } from '@/components/console/page-header.tsx';
import { GuardFindings } from '@/components/runtime/guard-findings.tsx';
import { GuardRoutesTable, type GuardRouteView } from '@/components/runtime/guard-routes.tsx';
import { CollapsibleGuardSetup, GuardSetupCard } from '@/components/runtime/guard-setup.tsx';
import { getViewer } from '@/lib/authz.ts';
import { hasRuntimeAccess } from '@/lib/entitlements.ts';
import {
  buildTargetSet,
  classifyRoutes,
  computeCoverage,
  coverageTone,
  isProbed,
  type GuardCoverage,
} from '@/lib/runtime/guard/coverage.ts';
import { collectGuardFindings } from '@/lib/runtime/guard/findings.ts';
import { formatRelativeTime } from '@/lib/runtime/guard/view.ts';

export const metadata = { title: 'Runtime Guard — ScanlyFix' };

type ProjectSummary = { id: string; name: string; url: string };

export default async function GuardPage({ searchParams }: { searchParams?: Promise<{ projectId?: string }> }) {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') notFound();

  const projects = await listProjects(viewer);
  const sp = searchParams ? await searchParams : {};
  const activeProject = projects.find((p) => p.id === sp?.projectId) ?? projects[0];

  if (!activeProject) {
    return (
      <Shell>
        <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-c-soft text-c-ink">
            <Icon name="shield" size={24} />
          </div>
          <h2 className="text-lg font-semibold text-c-ink">No projects under watch</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">
            Add a project from the dashboard to start observing routes and server actions with Guard.
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
        <ProjectSelector projects={projects} activeProjectId={projectId} />
        <GateCard
          title="Guard is a Pro feature"
          body="Guard records which routes and server actions your application actually serves, which of them only signed-in users reach, and what your middleware does when someone logged-out knocks."
          cta={{ label: 'Upgrade to Pro', href: '/settings/billing' }}
        />
      </Shell>
    );
  }

  const [routes, proberTargets] = await Promise.all([listGuardRoutes(projectId), listProberTargets(projectId)]);

  const targets = buildTargetSet(proberTargets.map((t) => t.path));
  const classified = classifyRoutes(routes);
  const coverage = computeCoverage(classified, targets);
  const findings = collectGuardFindings(classified, targets);

  const view: GuardRouteView[] = classified.map((route) => ({
    ...route,
    id: route.id ?? `${route.method} ${route.pattern}`,
    probed: isProbed(route, targets),
  }));

  return (
    <Shell>
      {projects.length > 1 && <ProjectSelector projects={projects} activeProjectId={projectId} />}
      <Subnav projectId={projectId} />

      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 items-center rounded-md bg-emerald-500/10 px-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            Active
          </span>
          <h2 className="text-base font-semibold text-c-ink">{activeProject.name}</h2>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-c-muted">
          Observed from inside your application. Guard builds the real inventory of routes and server actions, works out
          which of them only signed-in users reach, records what your middleware does with anonymous requests, and hands
          the logged-in surfaces to the nightly Auth Prober.
        </p>
      </div>

      {routes.length === 0 ? (
        <GuardSetupCard projectId={projectId} />
      ) : (
        <>
          <CoverageTiles coverage={coverage} />
          {coverage.outcomeDataMissing && <WrapMiddlewareHint />}
          <GuardFindings findings={findings} />
          <GuardRoutesTable projectId={projectId} routes={view} />
          <CollapsibleGuardSetup projectId={projectId} />
        </>
      )}
    </Shell>
  );
}

function CoverageTiles({ coverage }: { coverage: GuardCoverage }) {
  const tone = coverageTone(coverage);
  const coverageLabel = coverage.probeEligible === 0 ? '—' : `${coverage.coveragePct}%`;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        label="Probe coverage"
        value={coverageLabel}
        tone={tone === 'good' ? 'good' : tone === 'warn' ? 'warn' : 'bad'}
        hint={
          coverage.probeEligible === 0
            ? 'No logged-in-only GET routes observed yet'
            : `${coverage.probed} of ${coverage.probeEligible} logged-in GET routes are checked nightly`
        }
      />
      <Tile label="Routes observed" value={coverage.totalRoutes} hint={`${coverage.sampleRoutes} sample`} />
      <Tile label="Logged-in only" value={coverage.sessionOnly} tone="default" hint="Traffic almost always signed in" />
      <Tile
        label="Not probed"
        value={coverage.unprobed}
        tone={coverage.unprobed > 0 ? 'bad' : 'good'}
        hint="Logged-in GET routes nothing verifies"
      />
      <Tile
        label="Manual check"
        value={coverage.unverifiable}
        tone={coverage.unverifiable > 0 ? 'warn' : 'good'}
        hint="POST routes and server actions"
      />
      <Tile
        label="Last report"
        value={coverage.lastSeenAt ? formatRelativeTime(coverage.lastSeenAt) : '—'}
        tone="muted"
        small
        hint="Most recent request the SDK sent"
      />
    </div>
  );
}

function Tile({
  label,
  value,
  tone = 'default',
  hint,
  small = false,
}: {
  label: string;
  value: number | string;
  tone?: 'default' | 'good' | 'warn' | 'bad' | 'muted';
  hint?: string;
  small?: boolean;
}) {
  const valueCls =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-rose-600 dark:text-rose-400'
          : tone === 'muted'
            ? 'text-c-muted'
            : 'text-c-ink';
  return (
    <div className="rounded-xl border border-c-line bg-c-card px-4 py-3 shadow-sm" title={hint}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-c-muted">{label}</p>
      <p className={`mt-1 font-mono font-semibold ${small ? 'text-sm' : 'text-xl'} ${valueCls}`}>{value}</p>
      {hint && <p className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-c-muted">{hint}</p>}
    </div>
  );
}

function WrapMiddlewareHint() {
  return (
    <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-5">
      <p className="text-sm font-medium text-c-ink">Guard is watching, but not yet listening</p>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-c-muted">
        No middleware decision has been observed on any route, which means <code className="font-mono">withGuard()</code>{' '}
        was called without your own middleware. Wrap it —{' '}
        <code className="rounded bg-c-soft px-1 font-mono text-[11px]">export default withGuard(auth)</code> — and Guard
        can tell you whether anonymous requests were actually turned away, instead of only that they arrived.
      </p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Runtime — Guard" />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">{children}</div>
    </div>
  );
}

function Subnav({ projectId }: { projectId: string }) {
  const links = [
    { href: `/runtime?projectId=${projectId}`, label: 'Auth Prober', active: false },
    { href: `/runtime/guard?projectId=${projectId}`, label: 'Guard Routes', active: true },
    { href: `/runtime/ai?projectId=${projectId}`, label: 'AI Spend & Logs', active: false },
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

function ProjectSelector({ projects, activeProjectId }: { projects: ProjectSummary[]; activeProjectId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-c-line pb-4">
      <span className="text-xs font-medium uppercase tracking-wider text-c-muted">Project:</span>
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`/runtime/guard?projectId=${p.id}`}
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

import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getCanaryProjectConfig,
  getProject,
  listCanaries,
  listCanaryEvents,
  listProjects,
} from '@scanlyfix/db';

import { CanaryConsole } from './canary-console';
import { getViewer } from '@/lib/authz';
import { hasRuntimeAccess } from '@/lib/entitlements';
import { decryptValue } from '@/lib/header-encryption';
import { SELFTEST_KIND } from '@/lib/runtime/canaries/types';
import { PageHeader } from '@/components/console/page-header.tsx';
import { Icon } from '@/components/console/icons.tsx';

export const metadata = { title: 'Runtime Canaries — ScanlyFix' };

export default async function CanariesPage({
  searchParams,
}: {
  searchParams?: Promise<{ projectId?: string }>;
}) {
  const viewer = await getViewer();
  if (viewer.kind !== 'user') notFound();

  const projects = await listProjects(viewer);
  const sp = searchParams ? await searchParams : {};
  const activeProject = projects.find((p) => p.id === sp?.projectId) ?? projects[0];

  if (!activeProject) {
    return (
      <div className="console min-h-dvh bg-c-bg text-c-ink">
        <PageHeader title="Runtime — Canaries" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">
          <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-c-soft text-c-ink">
              <Icon name="shield" size={24} />
            </div>
            <h2 className="text-lg font-semibold text-c-ink">No projects under watch</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">
              Database canary intrusion detection monitors decoy rows in your Supabase database.
              Add a project from the dashboard to start.
            </p>
            <Link
              href="/dashboard#sites"
              className="mt-6 inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            >
              Add a domain
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const projectId = activeProject.id;
  const project = await getProject(projectId, viewer);
  if (!project) notFound();

  // Gate: Pro plan check
  const hasAccess = await hasRuntimeAccess(viewer, projectId);
  if (!hasAccess) {
    return (
      <div className="console min-h-dvh bg-c-bg text-c-ink">
        <PageHeader title="Runtime — Canaries" />
        <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">
          {projects.length > 1 && (
            <ProjectSelector projects={projects} activeProjectId={projectId} />
          )}
          <GateCard
            title="Canaries are a Pro feature"
            body="Decoy rows in your database that no legitimate code or user ever touches. If one is touched, an intruder was inside. Unlike scanner findings, canaries provide indisputable forensic proof with zero false positives."
            cta={{ label: 'See the plans', href: '/settings/billing' }}
          />
        </div>
      </div>
    );
  }

  const [cfg, canaries, events] = await Promise.all([
    getCanaryProjectConfig(projectId, decryptValue),
    listCanaries(projectId),
    listCanaryEvents(projectId),
  ]);

  const connected = cfg !== null;

  // The header badge used to be a hardcoded green "Active", which said the
  // feature was running before Supabase was even connected — the single most
  // misleading thing this page could claim.
  const decoys = canaries.filter((c) => c.kind !== SELFTEST_KIND);
  const live = decoys.filter((c) => c.status === 'planted' || c.status === 'compromised');
  const badge = !connected
    ? { label: 'Not connected', className: 'bg-c-soft text-c-muted' }
    : live.length === 0
      ? { label: 'Setup incomplete', className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' }
      : decoys.some((c) => c.status === 'compromised')
        ? { label: 'Compromised', className: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' }
        : { label: 'Watching', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' };

  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Runtime — Canaries" />

      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-6 py-8 sm:px-10">
        {/* Project switcher */}
        {projects.length > 1 && (
          <ProjectSelector projects={projects} activeProjectId={projectId} />
        )}

        {/* Subnav between Prober, Guard, AI, and Canaries */}
        <div className="flex items-center gap-2 border-b border-c-line pb-3">
          <Link
            href={`/runtime?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            Auth Prober
          </Link>
          <Link
            href={`/runtime/guard?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            Guard Routes
          </Link>
          <Link
            href={`/runtime/ai?projectId=${projectId}`}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            AI Spend &amp; Logs
          </Link>
          <span className="rounded-lg bg-c-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm">
            Canaries
          </span>
        </div>

        {/* Feature Header */}
        <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-semibold ${badge.className}`}>
                  {badge.label}
                </span>
                <h2 className="text-base font-semibold text-c-ink">{activeProject.name}</h2>
              </div>
              <p className="mt-1 text-sm text-c-muted">
                Decoys in your database that nothing legitimate ever reads or writes. If one is touched,
                someone was in there — unlike a scanner finding, there is nothing to triage and no
                false positive to argue with.
              </p>
            </div>
          </div>
        </div>

        <CanaryConsole
          projectId={projectId}
          connected={connected}
          anonKeyConnected={cfg?.anonKey != null}
          canaries={canaries.map((c) => ({
            marker: c.markerToken,
            kind: c.kind,
            status: c.status,
            integrity: c.lastIntegrity,
            lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
          }))}
          events={events.map((e) => ({
            id: e.id,
            kind: e.kind,
            detail: e.detail,
            source: e.source,
            detectedAt: e.detectedAt.toISOString(),
            acknowledgedAt: e.acknowledgedAt?.toISOString() ?? null,
          }))}
        />
      </div>
    </div>
  );
}

function ProjectSelector({
  projects,
  activeProjectId,
}: {
  projects: Array<{ id: string; name: string; url: string }>;
  activeProjectId: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-c-line pb-4">
      <span className="text-xs font-medium uppercase tracking-wider text-c-muted">Project:</span>
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        return (
          <Link
            key={p.id}
            href={`/runtime/canaries?projectId=${p.id}`}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              isActive
                ? 'bg-c-accent text-white shadow-sm'
                : 'border border-c-line bg-c-card text-c-muted hover:border-c-line/80 hover:text-c-ink'
            }`}
          >
            {p.name}
          </Link>
        );
      })}
    </div>
  );
}

function GateCard({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta: { label: string; href: string };
}) {
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
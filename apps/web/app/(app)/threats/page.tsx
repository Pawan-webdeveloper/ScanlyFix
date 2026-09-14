import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getProject, lastThreatEventAt, listGuardRoutes, listProjects } from '@scanlyfix/db';

import { getViewer } from '@/lib/authz';
import { hasThreatAccess } from '@/lib/entitlements';
import { Icon } from '@/components/console/icons.tsx';
import { PageHeader } from '@/components/console/page-header.tsx';
import { CollapsibleGuardSetup } from '@/components/runtime/guard-setup';

import { readThreatSnapshot } from './actions';
import { ThreatConsole } from './threat-console';
import { ThreatSetupCard } from './threat-setup';

export const metadata = { title: 'Live Threats — ScanlyFix' };

export default async function ThreatsPage({
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
      <Shell>
        <div className="rounded-xl border border-c-line bg-c-card p-10 text-center shadow-sm">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-c-soft text-c-ink">
            <Icon name="threat" size={24} />
          </div>
          <h2 className="text-lg font-semibold text-c-ink">No site under watch</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-c-muted">
            Live Threats records every hacking attempt against a site you have deployed. Add a domain to start.
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
  const project = await getProject(projectId, viewer);
  if (!project) notFound();

  // Free plan included while the detector is being tested. See hasThreatAccess.
  if (!(await hasThreatAccess(viewer, projectId))) notFound();

  const [snapshot, lastThreat, routes] = await Promise.all([
    readThreatSnapshot(projectId),
    lastThreatEventAt(projectId),
    // Threat events only exist once something was attacked, so their absence
    // proves nothing. Route observations are the signal that the middleware is
    // actually deployed and reporting — without this, a correctly installed SDK
    // on a site nobody has attacked yet would be told it was not connected.
    listGuardRoutes(projectId, { limit: 1, window: '30d' }),
  ]);

  const sdkConnected = lastThreat !== null || routes.length > 0;

  return (
    <Shell>
      {projects.length > 1 && <ProjectSelector projects={projects} activeProjectId={projectId} />}

      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-6 items-center rounded-md px-2 text-xs font-semibold ${
              sdkConnected
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-c-soft text-c-muted'
            }`}
          >
            {sdkConnected ? 'On' : 'Off'}
          </span>
          <h2 className="text-base font-semibold text-c-ink">{activeProject.name}</h2>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-c-muted">
          Every hacking attempt on your live site, logged as it happens — password guessing, database break-ins,
          malicious code. Detection runs inside your own app, so nothing is proxied through us and no request is slowed
          down.
        </p>
      </div>

      {!sdkConnected && (
        <>
          <ThreatSetupCard />
          <CollapsibleGuardSetup projectId={projectId} />
        </>
      )}

      <ThreatConsole
        projectId={projectId}
        projectName={activeProject.name}
        sdkConnected={sdkConnected}
        initial={snapshot}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="console min-h-dvh bg-c-bg text-c-ink">
      <PageHeader title="Live Threats" />
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-6 py-8 sm:px-10">{children}</div>
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
            href={`/threats?projectId=${p.id}`}
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

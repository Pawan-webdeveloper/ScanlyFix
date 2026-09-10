'use client';

import { useTransition } from 'react';
import type { GuardRouteRow } from '@scanlyfix/db';
import { refreshGuardAction, simulateSampleTrafficAction } from '@/app/(app)/runtime/guard/actions';

export type GuardRouteView = GuardRouteRow & { needsSession: boolean };

const NEW_ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const SETUP_SNIPPET = `// middleware.ts
import { withGuard } from '@scanlyfix/runtime-sdk';

export default withGuard();

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};`;

export function GuardSetupCard({ projectId }: { projectId: string }) {
  const [pending, startTransition] = useTransition();

  const setupEnv = `RUNTIME_PROJECT_ID=${projectId}
RUNTIME_SIGNING_SECRET=<signing-secret>
RUNTIME_INGEST_URL=https://scanlyfix.com/api/runtime/ingest`;

  function handleSimulate() {
    startTransition(async () => {
      await simulateSampleTrafficAction(projectId);
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-c-ink">Nothing has reported in from your app yet</h3>
            <p className="mt-1 text-sm text-c-muted">
              Guard connects via a lightweight middleware wrapper. Once configured, this dashboard reflects every real
              route and server action observed across live traffic.
            </p>
          </div>
          <button
            onClick={handleSimulate}
            disabled={pending}
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-c-accent px-3 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Simulating...' : 'Simulate Sample Traffic'}
          </button>
        </div>
        <pre className="mt-4 overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">{SETUP_SNIPPET}</pre>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">{setupEnv}</pre>
      </div>

      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-c-ink">What leaves your app</h3>
        <ul className="mt-3 space-y-2 text-sm text-c-muted">
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            Route patterns, normalized to file-tree representation (<code className="font-mono text-xs text-c-ink">/api/users/[id]</code>)
          </li>
          <li className="flex items-center gap-2">
            <span className="text-emerald-500">✓</span>
            HTTP method, server action indicator, and counts of requests with vs. without session
          </li>
          <li className="flex items-center gap-2 text-rose-500">
            <span>✗</span>
            Never collected: request/response bodies, authorization headers, cookie values, or sensitive tokens
          </li>
        </ul>
        <p className="mt-3 text-xs text-c-muted">
          Reporting runs non-blocking in the background — telemetry never slows down your application requests.
        </p>
      </div>
    </div>
  );
}

export function GuardRoutesTable({ projectId, routes }: { projectId: string; routes: GuardRouteView[] }) {
  const [pending, startTransition] = useTransition();

  function refresh() {
    startTransition(async () => {
      await refreshGuardAction(projectId);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-c-muted">
          {routes.length} routes & actions observed
        </p>
        <button
          onClick={refresh}
          disabled={pending}
          className="inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm transition-colors hover:bg-c-soft disabled:opacity-50"
        >
          {pending ? 'Syncing...' : 'Sync to Prober'}
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-c-line bg-c-card shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-c-line text-xs font-medium uppercase tracking-wider text-c-muted">
              <th className="px-4 py-3">Pattern</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Session Ratio</th>
              <th className="px-4 py-3">Total Requests</th>
              <th className="px-4 py-3">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-c-line">
            {routes.map((r) => {
              const total = r.withSession + r.withoutSession;
              const pct = total > 0 ? Math.round((r.withSession / total) * 100) : 0;
              const isNew = Date.now() - new Date(r.firstSeenAt).getTime() < NEW_ROUTE_WINDOW_MS;
              return (
                <tr key={r.id} className="hover:bg-c-soft/50">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-c-ink">
                    {r.pattern}
                    {isNew && (
                      <span className="ml-2 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                        new
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                        r.kind === 'server_action'
                          ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                          : 'bg-c-soft text-c-muted'
                      }`}
                    >
                      {r.kind === 'server_action' ? 'action' : r.method}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-c-soft">
                        <div className="h-full rounded-full bg-c-accent" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="font-mono text-xs text-c-muted">{pct}%</span>
                      {r.needsSession && (
                        <span className="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-600 dark:text-sky-400">
                          needs session → probed nightly
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-c-muted">{total}</td>
                  <td className="px-4 py-3 text-xs text-c-muted">
                    {new Date(r.lastSeenAt).toLocaleDateString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
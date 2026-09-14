'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { clearGuardRoutesAction, refreshGuardAction } from '@/app/(app)/runtime/guard/actions';
import { ENFORCEMENT_HINT, ENFORCEMENT_LABEL, SESSION_PROFILE_LABEL, type Enforcement, type SessionProfile } from '@/lib/runtime/guard/classify';
import type { ClassifiedRoute } from '@/lib/runtime/guard/coverage';
import {
  filterAndSortRoutes,
  formatRelativeTime,
  isNewRoute,
  matchesFilter,
  ROUTE_FILTER_LABEL,
  ROUTE_SORT_LABEL,
  sessionPct,
  type RouteFilter,
  type RouteSort,
} from '@/lib/runtime/guard/view';

/** A classified route plus whether the nightly prober already watches it. */
export type GuardRouteView = ClassifiedRoute & { id: string; probed: boolean };

const PROFILE_STYLE: Readonly<Record<SessionProfile, string>> = {
  session_only: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  mixed: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  public: 'bg-c-soft text-c-muted',
  unknown: 'bg-c-soft text-c-muted',
};

const ENFORCEMENT_STYLE: Readonly<Record<Enforcement, string>> = {
  enforced: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  inconsistent: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  unenforced: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  unknown: 'bg-c-soft text-c-muted',
};

const FILTERS: ReadonlyArray<RouteFilter> = ['all', 'attention', 'needs_session', 'public', 'sample'];
const SORTS: ReadonlyArray<RouteSort> = ['risk', 'last_seen', 'traffic', 'pattern'];

function ConfirmClearDialog({
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (confirmation: string) => void;
}) {
  const [value, setValue] = useState('');
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-c-line bg-c-card p-6 shadow-lg">
        <h3 className="text-base font-semibold text-c-ink">Clear the observed route inventory?</h3>
        <p className="mt-2 text-sm text-c-muted">
          This deletes every observed route for this project and every prober target that came from Guard. Manual and
          default prober targets are kept. Your app will rebuild the inventory as traffic arrives.
        </p>
        <label className="mt-4 block text-xs font-medium text-c-muted" htmlFor="guard-clear-confirm">
          Type <span className="font-mono font-semibold text-c-ink">CLEAR</span> to confirm
        </label>
        <input
          id="guard-clear-confirm"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 w-full rounded-lg border border-c-line bg-c-soft px-3 py-1.5 font-mono text-xs text-c-ink focus:outline-none focus:ring-1 focus:ring-c-accent"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 items-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink transition-colors hover:bg-c-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending || value.trim().toUpperCase() !== 'CLEAR'}
            onClick={() => onConfirm(value)}
            className="inline-flex h-8 items-center rounded-lg bg-rose-600 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {pending ? 'Clearing…' : 'Clear routes'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GuardRoutesTable({ projectId, routes }: { projectId: string; routes: GuardRouteView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [filter, setFilter] = useState<RouteFilter>('all');
  const [sort, setSort] = useState<RouteSort>('risk');
  const [search, setSearch] = useState('');
  const [clearOpen, setClearOpen] = useState(false);

  const visible = useMemo(() => filterAndSortRoutes(routes, { filter, search, sort }), [routes, filter, search, sort]);
  // Counted once per route list, not once per chip per render — the chips only
  // need a tally, and sorting five times to produce five numbers is waste.
  const filterCounts = useMemo(() => {
    const counts = Object.fromEntries(FILTERS.map((f) => [f, 0])) as Record<RouteFilter, number>;
    for (const route of routes) {
      for (const f of FILTERS) if (matchesFilter(route, f)) counts[f]++;
    }
    return counts;
  }, [routes]);

  function handleSync() {
    setMsg(null);
    startTransition(async () => {
      const res = await refreshGuardAction(projectId);
      if (!res.ok) {
        setMsg({ text: `Sync failed: ${res.error}`, error: true });
        return;
      }
      setMsg({ text: res.message });
      router.refresh();
    });
  }

  function handleClear(confirmation: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await clearGuardRoutesAction(projectId, confirmation);
      setClearOpen(false);
      if (res.ok) {
        setMsg({ text: `Cleared ${res.deletedRoutes} route(s) and ${res.deletedTargets} synced prober target(s).` });
        router.refresh();
      } else {
        setMsg({ text: `Clear failed: ${res.error}`, error: true });
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-c-line bg-c-card p-0.5 text-[11px]">
          {FILTERS.map((f) => {
            const count = filterCounts[f];
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-md px-2 py-1 font-medium transition-colors ${
                  filter === f ? 'bg-c-accent text-white' : 'text-c-muted hover:text-c-ink'
                }`}
              >
                {ROUTE_FILTER_LABEL[f]}
                <span className={`ml-1 font-mono ${filter === f ? 'text-white/70' : 'text-c-muted'}`}>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by path…"
            aria-label="Filter routes by path"
            className="h-8 w-44 rounded-lg border border-c-line bg-c-soft px-3 font-mono text-xs text-c-ink focus:outline-none focus:ring-1 focus:ring-c-accent"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as RouteSort)}
            aria-label="Sort routes"
            className="h-8 rounded-lg border border-c-line bg-c-card px-2 text-xs text-c-ink focus:outline-none focus:ring-1 focus:ring-c-accent"
          >
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {ROUTE_SORT_LABEL[s]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleSync}
            disabled={pending}
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-c-accent px-3 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Syncing…' : 'Sync to prober'}
          </button>
          <button
            type="button"
            onClick={() => setClearOpen(true)}
            disabled={pending}
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-muted transition-colors hover:bg-c-soft hover:text-rose-600 disabled:opacity-50 dark:hover:text-rose-400"
          >
            Clear
          </button>
        </div>
      </div>

      {msg && (
        <p className={`text-xs font-medium ${msg.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {msg.text}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-c-line bg-c-card shadow-sm">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-c-line text-xs font-medium uppercase tracking-wider text-c-muted">
              <th className="px-4 py-3">Route</th>
              <th className="px-4 py-3">Traffic</th>
              <th className="px-4 py-3">Profile</th>
              <th className="px-4 py-3">Middleware</th>
              <th className="px-4 py-3">Probed</th>
              <th className="px-4 py-3">Last seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-c-line">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-xs text-c-muted">
                  No routes match this filter.
                </td>
              </tr>
            ) : (
              visible.map((r) => {
                const pct = sessionPct(r);
                const isSample = r.source === 'sample';
                return (
                  <tr key={r.id} className="hover:bg-c-soft/50">
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs font-semibold text-c-ink">{r.pattern}</span>
                        <span className="rounded bg-c-soft px-1.5 py-0.5 font-mono text-[10px] text-c-muted">
                          {r.kind === 'server_action' ? 'action' : r.method}
                        </span>
                        {isSample && (
                          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            sample
                          </span>
                        )}
                        {!isSample && isNewRoute(r) && (
                          <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                            new
                          </span>
                        )}
                        {r.verdict.stale && (
                          <span
                            className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted"
                            title={`Not seen for ${r.verdict.ageDays} days`}
                          >
                            stale
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-c-muted">{r.verdict.categoryLabel}</p>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-c-soft" aria-hidden>
                          <div className="h-full rounded-full bg-c-accent" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="font-mono text-[11px] text-c-muted">{pct}% signed in</span>
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-c-muted">{r.verdict.total} requests</p>
                    </td>

                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${PROFILE_STYLE[r.verdict.sessionProfile]}`}
                      >
                        {SESSION_PROFILE_LABEL[r.verdict.sessionProfile]}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${ENFORCEMENT_STYLE[r.verdict.enforcement]}`}
                        title={ENFORCEMENT_HINT[r.verdict.enforcement]}
                      >
                        {ENFORCEMENT_LABEL[r.verdict.enforcement]}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-[11px]">
                      {isSample ? (
                        <span className="text-c-muted">—</span>
                      ) : !r.verdict.needsSession ? (
                        <span className="text-c-muted">not needed</span>
                      ) : !r.verdict.probeable ? (
                        <span className="text-amber-600 dark:text-amber-400" title="The prober only sends logged-out GET requests">
                          manual check
                        </span>
                      ) : r.probed ? (
                        <span className="text-emerald-600 dark:text-emerald-400">nightly</span>
                      ) : (
                        <span className="text-rose-600 dark:text-rose-400">not probed</span>
                      )}
                    </td>

                    <td className="px-4 py-3 font-mono text-[11px] text-c-muted">{formatRelativeTime(r.lastSeenAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <ConfirmClearDialog open={clearOpen} pending={pending} onCancel={() => setClearOpen(false)} onConfirm={handleClear} />
    </div>
  );
}

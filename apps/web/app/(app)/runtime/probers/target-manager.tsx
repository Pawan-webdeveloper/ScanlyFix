'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { runtimeProberTargets } from '@scanlyfix/db';
import { calculateBaselineAgeDays, detectFlappingPaths } from '@/lib/runtime/auth-prober/flap';
import { verdictForTarget } from '@/lib/runtime/auth-prober/summary';
import { CATEGORY_LABEL, categorizePath } from '@/lib/runtime/auth-prober/targets';
import { addTargetAction, deleteTargetAction, rerecordBaselineAction } from './action';

type ProberTarget = typeof runtimeProberTargets.$inferSelect;

const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  protected: { label: 'protected', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  open: { label: 'open', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  exposed: { label: 'exposed', cls: 'bg-rose-500/10 text-rose-600 dark:text-rose-400' },
  inconclusive: { label: 'inconclusive', cls: 'bg-c-soft text-c-muted' },
  baseline_recorded: { label: 'baseline', cls: 'bg-c-soft text-c-muted' },
};

export function TargetManager({
  projectId,
  targets,
  findings = [],
}: {
  projectId: string;
  targets: ProberTarget[];
  findings?: Array<{ path: string; createdAt: Date | string }>;
}) {
  const router = useRouter();
  const [newPath, setNewPath] = useState('');
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const flapAnalysis = detectFlappingPaths(findings);

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newPath.trim()) return;

    setMsg(null);
    startTransition(async () => {
      const res = await addTargetAction(projectId, newPath.trim());
      if (res.ok) {
        setNewPath('');
        setMsg({ text: res.message ?? 'Target added successfully!' });
        router.refresh();
      } else {
        setMsg({ text: res.error, error: true });
      }
    });
  }

  function handleRerecord(targetId: string, path: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await rerecordBaselineAction(projectId, targetId);
      if (res.ok) {
        setMsg({ text: res.message ?? `Re-recorded baseline for ${path}.` });
        router.refresh();
      } else {
        setMsg({ text: res.error, error: true });
      }
    });
  }

  function handleDelete(targetId: string, path: string) {
    if (!confirm(`Remove "${path}" from monitored targets?`)) return;

    setMsg(null);
    startTransition(async () => {
      const res = await deleteTargetAction(projectId, targetId);
      if (res.ok) {
        setMsg({ text: res.message ?? 'Target removed.' });
        router.refresh();
      } else {
        setMsg({ text: res.error, error: true });
      }
    });
  }

  const manualCount = targets.filter((t) => t.source === 'manual').length;
  const isCapReached = manualCount >= 25;

  return (
    <div className="space-y-4">
      {/* Header with target limits */}
      <div className="flex items-center justify-between text-xs text-c-muted">
        <span>
          Manual routes:{' '}
          <span className={`font-medium ${isCapReached ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-c-ink'}`}>
            {manualCount}/25
          </span>
        </span>
        <span className="font-mono text-[11px] text-c-muted">Method: GET · logged-out · no redirects followed</span>
      </div>

      {/* Add Custom Route Form */}
      <form onSubmit={handleAdd} className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            disabled={isCapReached}
            placeholder={
              isCapReached
                ? 'Maximum limit of 25 manual targets reached'
                : 'Add a route to probe (e.g. /api/admin, /internal/keys, /api/orders/[id])'
            }
            className="w-full rounded-lg border border-c-line bg-c-soft px-3 py-1.5 font-mono text-xs text-c-ink shadow-sm focus:outline-none focus:ring-1 focus:ring-c-accent disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={pending || !newPath.trim() || isCapReached}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-c-accent px-3 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving...' : '+ Add Route'}
        </button>
      </form>

      {msg && (
        <p className={`text-xs font-medium ${msg.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
          {msg.text}
        </p>
      )}

      {/* Table */}
      {targets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-c-line p-8 text-center">
          <p className="text-sm font-medium text-c-ink">No targets configured yet</p>
          <p className="mt-1 text-xs text-c-muted">
            Click &ldquo;Seed default routes &amp; probe&rdquo; above to monitor admin panels, APIs, debug endpoints and logged-in
            pages, or add a custom path above.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-c-line text-xs font-medium uppercase tracking-wider text-c-muted">
                <th className="py-3 pr-4">Path</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Baseline</th>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Latest</th>
                <th className="px-4 py-3">Verdict</th>
                <th className="px-4 py-3">Source</th>
                <th className="py-3 pl-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-c-line">
              {targets.map((t) => {
                const verdict = verdictForTarget(t);
                const style = verdict ? VERDICT_STYLE[verdict] : null;
                const isUnstable = flapAnalysis.isUnstable(t.path);
                const baselineAgeDays = calculateBaselineAgeDays(t.baselineAt);
                const needsRerecord = baselineAgeDays !== null && baselineAgeDays > 180;
                const category = categorizePath(t.path);

                return (
                  <tr key={t.id} className="hover:bg-c-soft/50">
                    <td className="py-3 pr-4 font-mono text-xs font-semibold text-c-ink">
                      <div className="flex items-center gap-2">
                        <span>{t.path}</span>
                        {isUnstable && (
                          <span
                            className="rounded border border-amber-500/20 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400"
                            title="Flapping route: regressed 3 or more times in the last 30 days"
                          >
                            unstable
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-c-muted">{CATEGORY_LABEL[category]}</td>
                    <td className="px-4 py-3 text-xs">
                      {t.baselineStatus ? (
                        <span className="inline-flex items-center rounded bg-c-soft px-2 py-0.5 font-mono text-xs font-medium text-c-ink">
                          {t.baselineStatus}
                        </span>
                      ) : (
                        <span className="text-c-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {baselineAgeDays !== null ? (
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-c-ink">{baselineAgeDays}d</span>
                          {needsRerecord && (
                            <button
                              type="button"
                              onClick={() => handleRerecord(t.id, t.path)}
                              disabled={pending}
                              className="inline-flex cursor-pointer items-center rounded border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
                              title={`Baseline is ${baselineAgeDays} days old (>180d). Click to re-record baseline.`}
                            >
                              re-record
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-c-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {t.lastActualStatus ? (
                        <span className="inline-flex items-center rounded bg-c-soft px-2 py-0.5 font-mono text-xs font-medium text-c-ink">
                          {t.lastActualStatus}
                        </span>
                      ) : (
                        <span className="text-c-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {style ? (
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px] font-medium ${style.cls}`}
                          title={t.lastReason ?? undefined}
                        >
                          {style.label}
                        </span>
                      ) : (
                        <span className="text-c-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className="rounded bg-c-soft px-1.5 py-0.5 font-mono text-[10px] capitalize text-c-muted">{t.source}</span>
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <button
                        onClick={() => handleDelete(t.id, t.path)}
                        disabled={pending}
                        className="text-xs text-c-muted transition-colors hover:text-rose-600 dark:hover:text-rose-400"
                        title="Delete target"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

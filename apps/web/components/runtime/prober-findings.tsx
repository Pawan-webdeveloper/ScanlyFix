'use client';

import { useTransition } from 'react';
import { resolveFindingAction } from '@/app/(app)/runtime/probers/action';

type Finding = {
  id: string;
  path: string;
  baselineStatus: number;
  actualStatus: number;
  severity: string;
  resolvedAt: Date | null;
  createdAt: Date;
};

export function ProberFindings({
  projectId,
  findings,
  openCount,
}: {
  projectId: string;
  findings: Finding[];
  openCount: number;
}) {
  const [pending, startTransition] = useTransition();

  if (findings.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center">
        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          ✓ All protected routes secured — no authentication regressions detected.
        </p>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-c-muted">
          Auth Regressions {openCount > 0 && <span className="text-rose-500">({openCount} open)</span>}
        </h3>
      </div>
      <div className="space-y-3">
        {findings.map((f) => {
          const isResolved = Boolean(f.resolvedAt);
          return (
            <div
              key={f.id}
              className={`rounded-xl border p-5 transition-colors ${
                isResolved
                  ? 'border-c-line bg-c-card/50 opacity-60'
                  : 'border-rose-500/30 bg-rose-500/5 dark:bg-rose-950/10'
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-c-ink">{f.path}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${
                        f.severity === 'critical'
                          ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {f.severity}
                    </span>
                    {isResolved && (
                      <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted">
                        Resolved
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-xs text-c-muted">
                    Previously received <span className="font-mono font-medium text-c-ink">{f.baselineStatus}</span> (protected),
                    now returns <span className="font-mono font-bold text-rose-600 dark:text-rose-400">{f.actualStatus}</span> —
                    endpoint is accessible without authentication.
                  </p>
                </div>
                {!isResolved && (
                  <button
                    disabled={pending}
                    onClick={() => {
                      startTransition(() => {
                        resolveFindingAction(projectId, f.id);
                      });
                    }}
                    className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm transition-colors hover:bg-c-soft disabled:opacity-50"
                  >
                    {pending ? 'Saving...' : 'Mark fixed'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
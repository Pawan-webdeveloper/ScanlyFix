'use client';

import { useMemo, useState } from 'react';

import { GUARD_FINDING_LABEL, type GuardFinding, type GuardSeverity } from '@/lib/runtime/guard/findings';
import { CopyButton } from './guard-setup';

const SEVERITY_STYLE: Readonly<Record<GuardSeverity, string>> = {
  critical: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  high: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  low: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
};

const CARD_STYLE: Readonly<Record<GuardSeverity, string>> = {
  critical: 'border-rose-500/30 bg-rose-500/5 dark:bg-rose-950/10',
  high: 'border-rose-500/30 bg-rose-500/5 dark:bg-rose-950/10',
  medium: 'border-amber-500/25 bg-amber-500/5',
  low: 'border-c-line bg-c-card',
};

function FindingCard({ finding }: { finding: GuardFinding }) {
  const [open, setOpen] = useState(false);
  const evidenceRows = useMemo(() => Object.entries(finding.evidence), [finding.evidence]);

  return (
    <div className={`rounded-xl border p-5 transition-colors ${CARD_STYLE[finding.severity]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-bold text-c-ink">
          {finding.method} {finding.pattern}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${SEVERITY_STYLE[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted">
          {GUARD_FINDING_LABEL[finding.kind]}
        </span>
        {finding.kindOfRoute === 'server_action' && (
          <span className="rounded bg-purple-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-purple-600 dark:text-purple-400">
            server action
          </span>
        )}
      </div>

      <p className="mt-2 text-sm font-medium text-c-ink">{finding.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-c-muted">{finding.impact}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-7 items-center rounded-md border border-c-line bg-c-card px-2.5 text-[11px] font-medium text-c-ink transition-colors hover:bg-c-soft"
        >
          {open ? 'Hide details' : 'How to fix'}
        </button>
        {finding.fixPrompt.length > 0 && <CopyButton text={finding.fixPrompt} label="Copy AI fix prompt" />}
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <ol className="list-decimal space-y-1 rounded-lg border border-c-line bg-c-card p-3 pl-7 text-xs text-c-ink">
            {finding.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {evidenceRows.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-c-line bg-c-card p-3 font-mono text-[11px]">
              {evidenceRows.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-c-muted">{key}</dt>
                  <dd className="text-c-ink">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

export function GuardFindings({ findings }: { findings: GuardFinding[] }) {
  const [showAll, setShowAll] = useState(false);

  if (findings.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center">
        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          ✓ No gaps found — every logged-in surface Guard observed is guarded and watched.
        </p>
      </div>
    );
  }

  const actionable = findings.filter((f) => f.severity !== 'low');
  const visible = showAll ? findings : actionable.length > 0 ? actionable : findings;
  const hidden = findings.length - visible.length;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-c-muted">
          Findings <span className="text-rose-500">({findings.length})</span>
        </h3>
        {hidden > 0 && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[11px] font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            Show {hidden} informational
          </button>
        )}
        {showAll && actionable.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="text-[11px] font-medium text-c-muted transition-colors hover:text-c-ink"
          >
            Hide informational
          </button>
        )}
      </div>
      <div className="space-y-3">
        {visible.map((f) => (
          <FindingCard key={f.id} finding={f} />
        ))}
      </div>
    </section>
  );
}

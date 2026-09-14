'use client';

import { useMemo, useState, useTransition } from 'react';
import { resolveFindingAction } from '@/app/(app)/runtime/probers/action';
import { detectFlappingPaths } from '@/lib/runtime/auth-prober/flap';
import { buildRemediation } from '@/lib/runtime/auth-prober/remediation';
import { CATEGORY_LABEL, categorizePath } from '@/lib/runtime/auth-prober/targets';
import type { FindingVariant, ProbeEvidence, TargetCategory } from '@/lib/runtime/auth-prober/types';

export type ProberFindingRow = {
  id: string;
  path: string;
  baselineStatus: number;
  actualStatus: number;
  severity: string;
  variant?: string | null;
  keyFingerprint?: string | null;
  category?: string | null;
  reason?: string | null;
  evidence?: unknown;
  resolvedAt: Date | string | null;
  createdAt: Date | string;
};

const VARIANT_LABEL: Record<Exclude<FindingVariant, null>, { text: string; cls: string; title: string }> = {
  anon_role: {
    text: 'anon-key exposure',
    cls: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
    title: 'Protected without a key, but readable with the public Supabase anon key (RLS gap)',
  },
  exposed: {
    text: 'open on first probe',
    cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    title: 'This surface was already reachable without login the first time it was probed',
  },
  sequential_id: {
    text: 'IDOR / sequential ids',
    cls: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    title: 'Neighbouring ids return different records without login — the table is enumerable',
  },
};

function asVariant(v: string | null | undefined): FindingVariant {
  return v === 'anon_role' || v === 'exposed' || v === 'sequential_id' ? v : null;
}

function asEvidence(e: unknown): ProbeEvidence | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (typeof o.bodyKind !== 'string') return null;
  return o as unknown as ProbeEvidence;
}

function asCategory(c: string | null | undefined, path: string): TargetCategory {
  return c === 'admin' || c === 'api' || c === 'debug' || c === 'auth_page' ? c : categorizePath(path);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="inline-flex h-7 items-center justify-center rounded-md border border-c-line bg-c-card px-2.5 text-[11px] font-medium text-c-ink transition-colors hover:bg-c-soft"
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function FindingCard({ projectId, f, isUnstable }: { projectId: string; f: ProberFindingRow; isUnstable: boolean }) {
  const [pending, startTransition] = useTransition();
  const [showFix, setShowFix] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  const isResolved = Boolean(f.resolvedAt);
  const variant = asVariant(f.variant);
  const category = asCategory(f.category, f.path);
  const evidence = asEvidence(f.evidence);
  const remediation = useMemo(
    () =>
      buildRemediation({
        path: f.path,
        variant,
        category,
        baselineStatus: f.baselineStatus,
        actualStatus: f.actualStatus,
        evidence,
        keyFingerprint: f.keyFingerprint,
      }),
    [f.path, variant, category, f.baselineStatus, f.actualStatus, evidence, f.keyFingerprint],
  );
  const vl = variant ? VARIANT_LABEL[variant] : null;

  return (
    <div
      className={`rounded-xl border p-5 transition-colors ${
        isResolved ? 'border-c-line bg-c-card/50 opacity-60' : 'border-rose-500/30 bg-rose-500/5 dark:bg-rose-950/10'
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
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
            <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted">{CATEGORY_LABEL[category]}</span>
            {vl && (
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${vl.cls}`} title={vl.title}>
                {vl.text}
              </span>
            )}
            {isUnstable && (
              <span
                className="rounded border border-amber-500/20 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400"
                title="Flapping route: regressed 3 or more times in the last 30 days — emails are paused for it"
              >
                unstable
              </span>
            )}
            {isResolved && <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted">Resolved</span>}
          </div>

          <p className="mt-1.5 text-sm font-medium text-c-ink">{remediation.title}</p>
          <p className="mt-1 text-xs text-c-muted">
            {variant === 'anon_role' ? (
              <>
                Responds <span className="font-mono font-medium text-c-ink">{f.baselineStatus}</span> without a key, but{' '}
                <span className="font-mono font-bold text-rose-600 dark:text-rose-400">{f.actualStatus}</span> with the public anon key
                {f.keyFingerprint && (
                  <>
                    {' '}
                    (fingerprint <code className="font-mono">{f.keyFingerprint}</code>)
                  </>
                )}
                .
              </>
            ) : variant === 'exposed' || variant === 'sequential_id' ? (
              <>
                Returns <span className="font-mono font-bold text-rose-600 dark:text-rose-400">{f.actualStatus}</span> with real content to a
                logged-out visitor.{f.reason ? ` ${f.reason}` : ''}
              </>
            ) : (
              <>
                Previously <span className="font-mono font-medium text-c-ink">{f.baselineStatus}</span> (protected), now{' '}
                <span className="font-mono font-bold text-rose-600 dark:text-rose-400">{f.actualStatus}</span> without authentication.
                {f.reason ? ` ${f.reason}` : ''}
              </>
            )}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowFix((v) => !v)}
              className="inline-flex h-7 items-center rounded-md border border-c-line bg-c-card px-2.5 text-[11px] font-medium text-c-ink hover:bg-c-soft"
            >
              {showFix ? 'Hide fix' : 'How to fix'}
            </button>
            {evidence && (
              <button
                type="button"
                onClick={() => setShowEvidence((v) => !v)}
                className="inline-flex h-7 items-center rounded-md border border-c-line bg-c-card px-2.5 text-[11px] font-medium text-c-ink hover:bg-c-soft"
              >
                {showEvidence ? 'Hide evidence' : 'Evidence'}
              </button>
            )}
            <CopyButton text={remediation.fixPrompt} label="Copy AI fix prompt" />
          </div>

          {showFix && (
            <div className="mt-3 rounded-lg border border-c-line bg-c-card p-3">
              <p className="text-xs text-c-muted">{remediation.impact}</p>
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-c-ink">
                {remediation.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          )}

          {showEvidence && evidence && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-c-line bg-c-card p-3 font-mono text-[11px]">
              <dt className="text-c-muted">status</dt>
              <dd className="text-c-ink">{f.actualStatus}</dd>
              <dt className="text-c-muted">content-type</dt>
              <dd className="break-all text-c-ink">{evidence.contentType ?? '—'}</dd>
              <dt className="text-c-muted">body</dt>
              <dd className="text-c-ink">
                {evidence.bodyBytes} bytes · {evidence.bodyKind.replace('_', ' ')}
              </dd>
              {evidence.title && (
                <>
                  <dt className="text-c-muted">title</dt>
                  <dd className="break-words text-c-ink">{evidence.title}</dd>
                </>
              )}
              {evidence.location && (
                <>
                  <dt className="text-c-muted">location</dt>
                  <dd className="break-all text-c-ink">{evidence.location}</dd>
                </>
              )}
              {evidence.bodySample && (
                <>
                  <dt className="text-c-muted">sample</dt>
                  <dd className="break-words text-c-muted">{evidence.bodySample}</dd>
                </>
              )}
            </dl>
          )}
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
            title="Marks the finding fixed. If the route is still open on the next probe, a new finding is raised."
          >
            {pending ? 'Saving...' : 'Mark fixed'}
          </button>
        )}
      </div>
    </div>
  );
}

export function ProberFindings({ projectId, findings, openCount }: { projectId: string; findings: ProberFindingRow[]; openCount: number }) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const flapAnalysis = detectFlappingPaths(findings);

  if (findings.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center">
        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          ✓ All protected routes secured — no authentication regressions detected.
        </p>
      </div>
    );
  }

  const visible = filter === 'open' ? findings.filter((f) => !f.resolvedAt) : findings;

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-c-muted">
          Findings {openCount > 0 && <span className="text-rose-500">({openCount} open)</span>}
        </h3>
        <div className="flex items-center gap-1 rounded-lg border border-c-line bg-c-card p-0.5 text-[11px]">
          {(['open', 'all'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`rounded-md px-2 py-1 font-medium capitalize transition-colors ${
                filter === k ? 'bg-c-accent text-white' : 'text-c-muted hover:text-c-ink'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-6 text-center">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">✓ No open findings — everything that regressed has been fixed.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((f) => (
            <FindingCard key={f.id} projectId={projectId} f={f} isUnstable={flapAnalysis.isUnstable(f.path)} />
          ))}
        </div>
      )}
    </section>
  );
}

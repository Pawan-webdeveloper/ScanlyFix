'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  generateSetupScriptAction,
  markEventReviewedAction,
  rePlantCanariesAction,
  runAnonAuditAction,
  runCanaryCheckAction,
} from './action';

type Canary = { marker: string; status: string; integrity: string | null; lastCheckedAt: string | null };
type Event = { id: string; kind: string; detail: string; source: string; detectedAt: string; acknowledgedAt?: string | null };
type AnonAuditResult = { readable: string[]; protectedCount: number };

const KIND_LABEL: Record<string, string> = {
  modified: 'Row modified', deleted: 'Row deleted', anon_readable: 'Anon-readable (RLS hole)',
  log_wiped: 'Log wiped (tamper)', honeytoken_hit: '🍯 Honeytoken hit', table_missing: 'Table missing',
};

export function CanaryConsole(props: {
  projectId: string; connected: boolean; planted: boolean; anonKeyConnected: boolean;
  canaries: Canary[]; events: Event[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sql, setSql] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [auditResult, setAuditResult] = useState<AnonAuditResult | null>(null);

  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [anonKey, setAnonKey] = useState('');

  const isCompromised = props.canaries.some((c) => c.status === 'compromised');

  function handleConnect() {
    if (!supabaseUrl.trim() || !serviceKey.trim()) {
      setMsg('Both Supabase URL and service role key are required.');
      return;
    }
    startTransition(async () => {
      setMsg('Connecting & validating Supabase...');
      try {
        const res = await fetch('/api/runtime/supabase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: props.projectId,
            url: supabaseUrl.trim(),
            serviceKey: serviceKey.trim(),
            anonKey: anonKey.trim() || undefined,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { ok: boolean; error?: string };
        if (j.ok) {
          setMsg('✓ Supabase connected successfully');
          setSupabaseUrl('');
          setServiceKey('');
          setAnonKey('');
          router.refresh();
        } else {
          setMsg(j.error ?? 'Connection failed');
        }
      } catch {
        setMsg('Connection request failed. Please verify network and credentials.');
      }
    });
  }

  function handleDisconnect() {
    if (!confirm('Are you sure you want to disconnect Supabase for this project?')) return;
    startTransition(async () => {
      setMsg('Disconnecting...');
      try {
        const res = await fetch('/api/runtime/supabase', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: props.projectId }),
        });
        const j = (await res.json().catch(() => ({}))) as { ok: boolean; error?: string };
        if (j.ok) {
          setMsg('Supabase disconnected.');
          setSql(null);
          router.refresh();
        } else {
          setMsg(j.error ?? 'Failed to disconnect');
        }
      } catch {
        setMsg('Failed to disconnect');
      }
    });
  }

  function gen() {
    startTransition(async () => {
      const r = await generateSetupScriptAction(props.projectId);
      if (r.ok && r.data) { setSql(r.data.sql); setMsg(null); }
      else if (!r.ok) setMsg(r.error);
    });
  }
  function replant() {
    startTransition(async () => {
      const r = await rePlantCanariesAction(props.projectId);
      if (r.ok && r.data) {
        setSql(r.data.sql);
        setMsg('Fresh setup script generated. Run the SQL in Supabase SQL editor, then click Verify setup.');
      } else if (!r.ok) {
        setMsg(r.error);
      }
    });
  }
  function markReviewed(eventId: string) {
    startTransition(async () => {
      const r = await markEventReviewedAction(props.projectId, eventId);
      if (!r.ok) setMsg(r.error);
    });
  }
  function verify() {
    startTransition(async () => {
      const res = await fetch('/api/runtime/supabase/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: props.projectId }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      setMsg(j.ok ? '✓ Setup verified — nightly checks active' : (j.error ?? 'verify failed'));
    });
  }
  function check() {
    startTransition(async () => {
      const r = await runCanaryCheckAction(props.projectId);
      setMsg(r.ok ? `Check done — ${r.data?.detections ?? 0} detections` : r.error);
    });
  }
  function runAudit() {
    startTransition(async () => {
      const r = await runAnonAuditAction(props.projectId);
      if (r.ok && r.data) setAuditResult(r.data);
      else if (!r.ok) setMsg(r.error);
    });
  }

  return (
    <div className="space-y-6">
      {/* ── CONNECTION STATUS / FORM ── */}
      {props.connected ? (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-c-line bg-c-card p-4 shadow-sm">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
            </span>
            <div>
              <p className="text-sm font-medium text-c-ink">Supabase Connected</p>
              <p className="text-xs text-c-muted">
                Service role key encrypted at rest · {props.anonKeyConnected ? 'Anon key connected (RLS audit ready)' : 'No anon key (RLS audit skipped)'}
              </p>
            </div>
          </div>
          <button
            onClick={handleDisconnect}
            disabled={pending}
            className="inline-flex h-7 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-muted transition-colors hover:border-c-line/80 hover:text-rose-500 disabled:opacity-50"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="space-y-4 rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
          <div>
            <h3 className="text-base font-semibold text-c-ink">Step 1: Connect your Supabase Database</h3>
            <p className="mt-1 text-sm text-c-muted">
              Canaries require REST access to monitor decoy rows and verify RLS policies. Your credentials are encrypted with AES-256-GCM at rest.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium uppercase tracking-wider text-c-muted">
                Supabase Project URL <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                placeholder="https://xyzcompany.supabase.co"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-c-line bg-c-soft px-3 py-2 text-sm text-c-ink placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-c-muted">
                Service Role Secret Key <span className="text-rose-500">*</span>
              </label>
              <input
                type="password"
                placeholder="sb_secret_... or eyJhbGciOi..."
                value={serviceKey}
                onChange={(e) => setServiceKey(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-c-line bg-c-soft px-3 py-2 text-sm text-c-ink placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-c-muted">
                Must have <code>service_role</code> privileges to inspect decoy row hashes.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-c-muted">
                Anon Public Key <span className="text-c-muted/60">(Optional)</span>
              </label>
              <input
                type="text"
                placeholder="eyJhbGciOi..."
                value={anonKey}
                onChange={(e) => setAnonKey(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-c-line bg-c-soft px-3 py-2 text-sm text-c-ink placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-c-muted">
                Used for zero-body HEAD audit to detect tables exposed without RLS.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleConnect}
              disabled={pending || !supabaseUrl.trim() || !serviceKey.trim()}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Connecting…' : 'Connect Supabase'}
            </button>
            {msg && (
              <span className={`text-xs font-medium ${msg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {msg}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── SETUP SQL FLOW (STEP 2) ── */}
      {props.connected && !props.planted && (
        <div className="space-y-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 shadow-sm">
          <div>
            <h3 className="text-base font-semibold text-c-ink">Step 2: Run the setup SQL in Supabase</h3>
            <p className="mt-1 text-sm text-c-muted">
              Run this generated SQL in your Supabase Dashboard → SQL Editor. It creates a private decoy vault table
              (<code>scanlyfix_canaries</code>) and AFTER triggers with <code>SECURITY DEFINER</code>. Your app tables
              and user data are never touched or modified.
            </p>
          </div>
          {!sql && (
            <button
              onClick={gen}
              disabled={pending}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Generating…' : 'Generate setup SQL'}
            </button>
          )}
          {sql && (
            <div className="space-y-3">
              <pre className="max-h-72 overflow-auto rounded-lg border border-c-line bg-c-card p-3 font-mono text-xs text-c-ink">{sql}</pre>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={verify}
                  disabled={pending}
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {pending ? 'Verifying…' : 'Verify setup'}
                </button>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(sql);
                    setMsg('✓ SQL copied to clipboard');
                  }}
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-c-line bg-c-card px-4 text-sm font-medium text-c-ink shadow-sm hover:bg-c-soft"
                >
                  Copy SQL
                </button>
              </div>
            </div>
          )}
          {msg && (
            <p className={`text-xs font-medium ${msg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {msg}
            </p>
          )}
        </div>
      )}

      {/* ── CONTROLS ── */}
      {props.planted && (
        <div className="space-y-4">
          {isCompromised && (
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 shadow-sm">
              <div>
                <p className="text-sm font-medium text-rose-600 dark:text-rose-400">Canaries Compromised</p>
                <p className="text-xs text-c-muted">
                  Decoy rows were modified, missing, or exfiltrated. Re-plant to deploy fresh markers and reset your baseline.
                </p>
              </div>
              <button
                onClick={replant}
                disabled={pending}
                className="shrink-0 rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-rose-700 shadow-sm disabled:opacity-50"
              >
                {pending ? 'Generating…' : 'Re-plant canaries'}
              </button>
            </div>
          )}

          {sql && (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 shadow-sm">
              <h3 className="text-base font-semibold text-c-ink">Step 2: Run the updated setup SQL in Supabase</h3>
              <p className="text-sm text-c-muted">
                Copy and run this SQL in Supabase SQL Editor to plant the fresh canary rows and triggers.
                Then click &quot;Verify setup&quot; to establish the new snapshot baseline.
              </p>
              <pre className="max-h-72 overflow-auto rounded-lg border border-c-line bg-c-card p-3 font-mono text-xs text-c-ink">{sql}</pre>
              <div className="flex gap-2">
                <button
                  onClick={verify}
                  disabled={pending}
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Verify setup
                </button>
                <button
                  onClick={() => { void navigator.clipboard.writeText(sql); setMsg('✓ SQL copied'); }}
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-c-line bg-c-card px-4 text-sm font-medium text-c-ink shadow-sm hover:bg-c-soft"
                >
                  Copy SQL
                </button>
              </div>
              {msg && (
                <p className={`text-xs font-medium ${msg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {msg}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-c-line bg-c-card p-4 shadow-sm">
            <button
              onClick={check}
              disabled={pending}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm hover:bg-c-soft disabled:opacity-50"
            >
              {pending ? 'Checking…' : 'Run check now'}
            </button>
            <button
              onClick={runAudit}
              disabled={pending || !props.anonKeyConnected}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm hover:bg-c-soft disabled:opacity-50"
            >
              Run anon-access audit
            </button>
            {!props.anonKeyConnected && (
              <span className="text-xs text-c-muted">Connect your anon key to enable RLS probe and audit</span>
            )}
            {msg && <span className="text-xs text-c-muted">{msg}</span>}
          </div>
        </div>
      )}

      {/* ── AUDIT REPORT ── */}
      {auditResult && (
        <div className={`rounded-xl border p-4 shadow-sm ${auditResult.readable.length > 0 ? 'border-rose-500/40 bg-rose-500/5' : 'border-emerald-500/30 bg-emerald-500/5'}`}>
          <h3 className="text-sm font-medium text-c-ink">Anon-access audit</h3>
          {auditResult.readable.length === 0 ? (
            <p className="mt-1 text-sm text-emerald-600 dark:text-emerald-400">✓ No tables are readable via anon key — RLS policies are secure.</p>
          ) : (
            <div className="mt-2">
              <p className="text-sm font-medium text-rose-600 dark:text-rose-400">🚨 These tables are publicly readable by the internet (via public anon key):</p>
              <ul className="mt-1 list-inside list-disc font-mono text-xs text-c-ink">
                {auditResult.readable.map((t) => <li key={t}>{t}</li>)}
              </ul>
              <p className="mt-2 text-xs text-c-muted">
                {auditResult.protectedCount} tables protected · only table names are reported, table rows are never read (zero-body HEAD count).
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── CANARY ROWS ── */}
      {props.canaries.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-c-line bg-c-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-c-line bg-c-soft/60 text-left text-xs uppercase tracking-wider text-c-muted">
                <th className="px-4 py-2.5">Marker</th>
                <th className="px-4">Status</th>
                <th className="px-4">Integrity</th>
                <th className="px-4">Last checked</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-c-line">
              {props.canaries.map((c) => (
                <tr key={c.marker} className="text-c-ink">
                  <td className="px-4 py-2.5 font-mono text-xs">{c.marker}</td>
                  <td className="px-4">
                    <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      c.status === 'planted'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : c.status === 'compromised'
                        ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400'
                        : 'bg-c-soft text-c-muted'
                    }`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 text-xs text-c-muted">{c.integrity ?? '—'}</td>
                  <td className="px-4 text-xs text-c-muted">{c.lastCheckedAt ? new Date(c.lastCheckedAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── EVENTS TIMELINE ── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-c-muted">
          Events {props.events.length > 0 && <span className="text-rose-600">({props.events.length})</span>}
        </h2>
        {props.events.length === 0 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center shadow-sm">
            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">✓ No canaries touched. All quiet.</p>
          </div>
        ) : (
          props.events.map((e) => {
            const isAck = !!e.acknowledgedAt;
            return (
              <div
                key={e.id}
                className={`rounded-xl border p-4 shadow-sm transition-colors ${
                  isAck
                    ? 'border-c-line/60 bg-c-soft/40 opacity-80'
                    : 'border-rose-500/40 bg-c-card'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className={`text-sm font-medium ${isAck ? 'text-c-ink' : 'text-rose-600 dark:text-rose-400'}`}>
                      {KIND_LABEL[e.kind] ?? e.kind}
                    </p>
                    {isAck ? (
                      <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted">
                        ✓ Reviewed {e.acknowledgedAt ? new Date(e.acknowledgedAt).toLocaleDateString() : ''}
                      </span>
                    ) : (
                      <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-600 dark:text-rose-400">
                        New
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-c-muted">
                      {new Date(e.detectedAt).toLocaleString()} · {e.source}
                    </span>
                    {!isAck && (
                      <button
                        onClick={() => markReviewed(e.id)}
                        disabled={pending}
                        className="rounded-lg border border-c-line bg-c-card px-2 py-0.5 text-xs font-medium text-c-muted hover:border-c-line/80 hover:text-c-ink shadow-sm disabled:opacity-50"
                      >
                        Mark reviewed
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm text-c-muted">{e.detail}</p>
              </div>
            );
          })
        )}
      </section>

      {/* ── HONESTY CARD ── */}
      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-c-ink">What canaries can — and cannot — tell you</h3>
        <ul className="mt-3 space-y-2 text-sm text-c-muted">
          <li>✓ <strong>Writes (modify/delete):</strong> Enforced via AFTER triggers — deterministic and tamper-evident (trigger log wipe is recorded as an incident).</li>
          <li>✓ <strong>Reads:</strong> Postgres lacks SELECT triggers — instead of waiting, we actively test read access with the public anon key (RLS probe). Deterministic.</li>
          <li>✓ <strong>Exfiltration:</strong> Decoy honeytoken URLs — a hit is incontrovertible proof that leaked data was accessed.</li>
          <li className="text-c-muted/70">✗ <strong>What we cannot see:</strong> Specific application user identities at the DB connection level, and non-Supabase databases. We never claim visibility where we have none.</li>
        </ul>
      </div>
    </div>
  );
}
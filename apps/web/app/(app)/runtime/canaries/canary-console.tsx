'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  generateSetupScriptAction,
  markEventReviewedAction,
  rePlantCanariesAction,
  runAnonAuditAction,
  runCanaryCheckAction,
} from './action';
import {
  BADGE_CLASS,
  PANEL_CLASS,
  STATUS_LEGEND_ROWS,
  TEXT_CLASS,
  decoyLabel,
  deriveBanner,
  deriveState,
  eventLegend,
  integrityLegend,
  statusLegend,
  type AnonAuditResult,
  type CanaryEventRow,
  type CanaryRow,
  type Tone,
} from './canary-view';

type Notice = { tone: Exclude<Tone, 'neutral'>; text: string };

/** Events shown before "Show older" is needed. */
const EVENT_PAGE_SIZE = 10;

export function CanaryConsole(props: {
  projectId: string;
  connected: boolean;
  anonKeyConnected: boolean;
  canaries: CanaryRow[];
  events: CanaryEventRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sql, setSql] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [audit, setAudit] = useState<AnonAuditResult | null>(null);

  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [anonKey, setAnonKey] = useState('');

  const [onlyUnreviewed, setOnlyUnreviewed] = useState(true);
  const [visibleEvents, setVisibleEvents] = useState(EVENT_PAGE_SIZE);

  // ── Derived state ────────────────────────────────────────────────────────
  // Both of these are pure functions in ./canary-view so they can be tested
  // without a DOM: the stage decides which controls exist at all, and the banner
  // is the one sentence the customer actually reads.
  const { decoys, selfTest, stage, compromised, lastVerifiedAt } = useMemo(
    () => deriveState(props.canaries, props.connected),
    [props.canaries, props.connected],
  );

  const unreviewed = useMemo(() => props.events.filter((e) => e.acknowledgedAt === null), [props.events]);
  const shownEvents = onlyUnreviewed ? unreviewed : props.events;

  const banner = useMemo(() => deriveBanner({ decoys, selfTest, stage, compromised, lastVerifiedAt }, unreviewed), [
    decoys,
    selfTest,
    stage,
    compromised,
    lastVerifiedAt,
    unreviewed,
  ]);

  // ── Actions ──────────────────────────────────────────────────────────────
  function handleConnect() {
    if (!supabaseUrl.trim() || !serviceKey.trim()) {
      setNotice({ tone: 'critical', text: 'Both the Supabase URL and the service role key are required.' });
      return;
    }
    startTransition(async () => {
      setNotice({ tone: 'warn', text: 'Connecting and validating the key…' });
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
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (body.ok) {
          setSupabaseUrl('');
          setServiceKey('');
          setAnonKey('');
          setNotice({ tone: 'ok', text: 'Supabase connected. Generate the setup SQL next.' });
          router.refresh();
        } else {
          setNotice({ tone: 'critical', text: body.error ?? 'The connection could not be saved.' });
        }
      } catch {
        setNotice({ tone: 'critical', text: 'The request did not reach the server. Check your network and try again.' });
      }
    });
  }

  function handleDisconnect() {
    const warning =
      decoys.length > 0
        ? 'Disconnecting stops all monitoring and retires the current decoys. The rows stay in your database until you drop them yourself. Continue?'
        : 'Disconnect Supabase for this project?';
    if (!confirm(warning)) return;
    startTransition(async () => {
      try {
        const res = await fetch('/api/runtime/supabase', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: props.projectId }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (body.ok) {
          setSql(null);
          setAudit(null);
          setNotice({ tone: 'warn', text: 'Supabase disconnected. Nothing is being watched.' });
          router.refresh();
        } else {
          setNotice({ tone: 'critical', text: body.error ?? 'The connection could not be removed.' });
        }
      } catch {
        setNotice({ tone: 'critical', text: 'The request did not reach the server.' });
      }
    });
  }

  function generate() {
    startTransition(async () => {
      const r = await generateSetupScriptAction(props.projectId);
      if (r.ok && r.data) {
        setSql(r.data.sql);
        setNotice({ tone: 'warn', text: 'Run this SQL in Supabase, then click "Verify setup".' });
      } else if (!r.ok) {
        setNotice({ tone: 'critical', text: r.error });
      }
    });
  }

  function replant() {
    if (
      !confirm(
        'Re-planting retires the current decoys and issues a new set with new markers. You will need to run the new SQL in Supabase before monitoring resumes. Continue?',
      )
    ) {
      return;
    }
    startTransition(async () => {
      const r = await rePlantCanariesAction(props.projectId);
      if (r.ok && r.data) {
        setSql(r.data.sql);
        setNotice({ tone: 'warn', text: r.message ?? 'Fresh decoys registered. Run the SQL below, then verify.' });
        router.refresh();
      } else if (!r.ok) {
        setNotice({ tone: 'critical', text: r.error });
      }
    });
  }

  function verify() {
    startTransition(async () => {
      try {
        const res = await fetch('/api/runtime/supabase/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectId: props.projectId }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (body.ok) {
          setSql(null);
          setNotice({ tone: 'ok', text: 'Setup verified. The decoys are being watched and nightly checks are on.' });
          router.refresh();
        } else {
          setNotice({ tone: 'critical', text: body.error ?? 'The setup could not be verified.' });
        }
      } catch {
        setNotice({ tone: 'critical', text: 'The request did not reach the server.' });
      }
    });
  }

  function check() {
    startTransition(async () => {
      const r = await runCanaryCheckAction(props.projectId);
      if (!r.ok) {
        setNotice({ tone: 'critical', text: r.error });
        return;
      }
      // The action already phrases the outcome, including the case where the
      // database was unreachable and therefore nothing was verified.
      const clean = r.data?.reachable === true && (r.data?.detections ?? 0) === 0;
      setNotice({ tone: clean ? 'ok' : 'warn', text: r.message ?? 'Check complete.' });
      router.refresh();
    });
  }

  function runAudit() {
    startTransition(async () => {
      const r = await runAnonAuditAction(props.projectId);
      if (r.ok && r.data) {
        setAudit(r.data);
        setNotice(null);
      } else if (!r.ok) {
        setNotice({ tone: 'critical', text: r.error });
      }
    });
  }

  function markReviewed(eventId: string) {
    startTransition(async () => {
      const r = await markEventReviewedAction(props.projectId, eventId);
      if (!r.ok) setNotice({ tone: 'critical', text: r.error });
      else router.refresh();
    });
  }

  async function copySql(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice({ tone: 'ok', text: 'SQL copied to the clipboard.' });
    } catch {
      // Clipboard access is blocked outside a secure context and in some
      // browsers without a user gesture. Saying so beats a button that silently
      // does nothing.
      setNotice({ tone: 'warn', text: 'The clipboard is not available here — select the SQL above and copy it manually.' });
    }
  }

  const showControls = stage === 'live' || stage === 'awaiting_sql';

  return (
    <div className="space-y-6">
      {/* ── HEADLINE ─────────────────────────────────────────────────────── */}
      <div className={`rounded-xl border p-5 shadow-sm ${PANEL_CLASS[banner.tone]}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={`text-sm font-semibold ${banner.tone === 'neutral' ? 'text-c-ink' : TEXT_CLASS[banner.tone]}`}>
              {banner.title}
            </p>
            <p className="mt-1 max-w-2xl text-sm text-c-muted">{banner.body}</p>
          </div>
          {lastVerifiedAt && (
            <p className="text-xs text-c-muted">
              Last verified <Timestamp iso={lastVerifiedAt} />
            </p>
          )}
        </div>
      </div>

      {notice && (
        <p className={`rounded-lg border px-4 py-2.5 text-sm ${PANEL_CLASS[notice.tone]} ${TEXT_CLASS[notice.tone]}`} role="status">
          {notice.text}
        </p>
      )}

      {/* ── CONNECTION ───────────────────────────────────────────────────── */}
      {props.connected ? (
        <div className="flex flex-col justify-between gap-3 rounded-xl border border-c-line bg-c-card p-4 shadow-sm sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            <div>
              <p className="text-sm font-medium text-c-ink">Supabase connected</p>
              <p className="text-xs text-c-muted">
                Service role key encrypted at rest ·{' '}
                {props.anonKeyConnected ? 'anon key connected, RLS audit available' : 'no anon key, RLS audit unavailable'}
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
            <h3 className="text-base font-semibold text-c-ink">Step 1 — Connect your Supabase database</h3>
            <p className="mt-1 text-sm text-c-muted">
              Canaries need REST access to read the decoy rows and to test what an anonymous visitor can reach. Both keys
              are encrypted with AES-256-GCM before they are stored.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="cy-url" className="block text-xs font-medium uppercase tracking-wider text-c-muted">
                Supabase project URL <span className="text-rose-500">*</span>
              </label>
              <input
                id="cy-url"
                type="url"
                autoComplete="off"
                placeholder="https://xyzcompany.supabase.co"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-c-line bg-c-soft px-3 py-2 text-sm text-c-ink placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="cy-service" className="block text-xs font-medium uppercase tracking-wider text-c-muted">
                Service role secret key <span className="text-rose-500">*</span>
              </label>
              <input
                id="cy-service"
                type="password"
                autoComplete="off"
                placeholder="sb_secret_… or eyJhbGciOi…"
                value={serviceKey}
                onChange={(e) => setServiceKey(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-c-line bg-c-soft px-3 py-2 text-sm text-c-ink placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-c-muted">
                Needs <code>service_role</code> rights so the decoy rows can be read past RLS. Never sent to the browser
                again once saved.
              </p>
            </div>

            <div>
              <label htmlFor="cy-anon" className="block text-xs font-medium uppercase tracking-wider text-c-muted">
                Anon public key <span className="text-c-muted/60">(optional)</span>
              </label>
              <input
                id="cy-anon"
                type="text"
                autoComplete="off"
                placeholder="eyJhbGciOi…"
                value={anonKey}
                onChange={(e) => setAnonKey(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-c-line bg-c-soft px-3 py-2 text-sm text-c-ink placeholder:text-c-muted/50 focus:border-c-accent focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-c-muted">
                Lets us ask, as an anonymous visitor, how many rows each table returns. Only table names are recorded; no
                row is ever read.
              </p>
            </div>
          </div>

          <button
            onClick={handleConnect}
            disabled={pending || !supabaseUrl.trim() || !serviceKey.trim()}
            className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Connecting…' : 'Connect Supabase'}
          </button>
        </div>
      )}

      {/* ── SETUP SQL ────────────────────────────────────────────────────── */}
      {props.connected && (stage !== 'live' || sql !== null) && (
        <div className="space-y-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 shadow-sm">
          <div>
            <h3 className="text-base font-semibold text-c-ink">Step 2 — Run the setup SQL in Supabase</h3>
            <p className="mt-1 text-sm text-c-muted">
              Paste this into Supabase → SQL Editor. It creates one private table (<code>scanlyfix_canaries</code>), a
              tamper log, and an <code>AFTER UPDATE OR DELETE</code> trigger. Your own tables and data are never read or
              modified.
            </p>
          </div>

          {sql === null ? (
            <button
              onClick={generate}
              disabled={pending}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Generating…' : stage === 'awaiting_sql' ? 'Generate a new setup SQL' : 'Generate setup SQL'}
            </button>
          ) : (
            <div className="space-y-3">
              <pre className="max-h-72 overflow-auto rounded-lg border border-c-line bg-c-card p-3 font-mono text-xs text-c-ink">
                {sql}
              </pre>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={verify}
                  disabled={pending}
                  className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {pending ? 'Verifying…' : 'Verify setup'}
                </button>
                <button
                  onClick={() => void copySql(sql)}
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-c-line bg-c-card px-4 text-sm font-medium text-c-ink shadow-sm hover:bg-c-soft"
                >
                  Copy SQL
                </button>
                <button
                  onClick={() => setSql(null)}
                  className="inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium text-c-muted hover:text-c-ink"
                >
                  Hide
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CONTROLS ─────────────────────────────────────────────────────── */}
      {showControls && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-c-line bg-c-card p-4 shadow-sm">
          <button
            onClick={check}
            disabled={pending}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm hover:bg-c-soft disabled:opacity-50"
          >
            {pending ? 'Working…' : 'Run check now'}
          </button>
          <button
            onClick={runAudit}
            disabled={pending || !props.anonKeyConnected}
            title={props.anonKeyConnected ? undefined : 'Add your anon public key to enable this'}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm hover:bg-c-soft disabled:opacity-50"
          >
            Run anon-access audit
          </button>
          {/* Re-planting is the recovery path, so it must be reachable at all
              times — not only once something has already gone wrong. */}
          <button
            onClick={replant}
            disabled={pending}
            className={`inline-flex h-8 items-center justify-center rounded-lg px-3 text-xs font-medium shadow-sm disabled:opacity-50 ${
              compromised.length > 0
                ? 'bg-rose-600 text-white hover:bg-rose-700'
                : 'border border-c-line bg-c-card text-c-ink hover:bg-c-soft'
            }`}
          >
            Re-plant decoys
          </button>
          {!props.anonKeyConnected && (
            <span className="text-xs text-c-muted">Connect an anon key to test what the public can read.</span>
          )}
        </div>
      )}

      {/* ── ANON AUDIT REPORT ────────────────────────────────────────────── */}
      {audit && <AuditReport report={audit} onDismiss={() => setAudit(null)} />}

      {/* ── SELF-TEST ────────────────────────────────────────────────────── */}
      {selfTest && stage === 'live' && <SelfTestCard row={selfTest} />}

      {/* ── DECOY ROWS ───────────────────────────────────────────────────── */}
      {decoys.length > 0 && <DecoyTable rows={decoys} />}

      {/* ── EVENTS ───────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-c-muted">
            Events{' '}
            {unreviewed.length > 0 ? (
              <span className="text-rose-600 dark:text-rose-400">({unreviewed.length} unreviewed)</span>
            ) : (
              <span className="text-c-muted">({props.events.length})</span>
            )}
          </h2>
          {props.events.length > 0 && (
            <div className="flex items-center gap-1 rounded-lg border border-c-line bg-c-card p-0.5">
              {(
                [
                  { key: true, label: `Unreviewed${unreviewed.length > 0 ? ` (${unreviewed.length})` : ''}` },
                  { key: false, label: `All (${props.events.length})` },
                ] as const
              ).map((tab) => (
                <button
                  key={String(tab.key)}
                  onClick={() => {
                    setOnlyUnreviewed(tab.key);
                    setVisibleEvents(EVENT_PAGE_SIZE);
                  }}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    onlyUnreviewed === tab.key ? 'bg-c-accent text-white' : 'text-c-muted hover:text-c-ink'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {shownEvents.length === 0 ? (
          <div
            className={`rounded-xl border p-6 text-center shadow-sm ${
              props.events.length === 0 ? PANEL_CLASS.ok : 'border-c-line bg-c-card'
            }`}
          >
            <p className={`text-sm font-medium ${props.events.length === 0 ? TEXT_CLASS.ok : 'text-c-muted'}`}>
              {props.events.length === 0
                ? 'No decoy row has ever been touched.'
                : 'Everything here has been reviewed.'}
            </p>
          </div>
        ) : (
          <>
            {shownEvents.slice(0, visibleEvents).map((e) => (
              <EventCard key={e.id} event={e} pending={pending} onReview={() => markReviewed(e.id)} />
            ))}
            {shownEvents.length > visibleEvents && (
              <button
                onClick={() => setVisibleEvents((n) => n + EVENT_PAGE_SIZE)}
                className="w-full rounded-lg border border-c-line bg-c-card px-4 py-2 text-xs font-medium text-c-muted shadow-sm hover:text-c-ink"
              >
                Show older ({shownEvents.length - visibleEvents} more)
              </button>
            )}
          </>
        )}
      </section>

      {/* ── HONESTY CARD ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-c-ink">What canaries can — and cannot — tell you</h3>
        <ul className="mt-3 space-y-2 text-sm text-c-muted">
          <li>
            <strong className="text-c-ink">Writes are proven.</strong> An <code>AFTER UPDATE OR DELETE</code> trigger
            records every change to a decoy row, with the operation and the time. Rows vanishing from that log is itself
            reported.
          </li>
          <li>
            <strong className="text-c-ink">Reads are tested, not witnessed.</strong> Postgres has no SELECT trigger, so
            instead of waiting we ask your database — with the public anon key — whether the decoy table answers at all.
          </li>
          <li>
            <strong className="text-c-ink">Exfiltration is proven.</strong> Each decoy carries a URL that exists nowhere
            else. A request to it means the decoy data left your database and was opened.
          </li>
          <li>
            <strong className="text-c-ink">We check ourselves.</strong> Every run rewrites one decoy row we own — the
            self-test — and then asks the log whether it noticed. That is the only way &ldquo;no alerts&rdquo; can mean
            anything. Its own writes are excluded from detection and never alert you.
          </li>
          <li className="text-c-muted/70">
            <strong>What we cannot see:</strong> which application user made a change (the database sees one connection,
            not your end users), reads that never touch a decoy, and databases that are not Supabase. We do not claim
            visibility we do not have.
          </li>
        </ul>
      </div>
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

/**
 * A time the reader can trust.
 *
 * This is a client component that also renders on the server, where the locale
 * and time zone belong to the machine rather than the reader. Formatting only
 * after mount keeps both renders identical and still shows the reader's own
 * time. The date used to be rendered with `toLocaleDateString`, which dropped
 * the clock time entirely — useless for an intrusion timeline.
 */
function Timestamp({ iso }: { iso: string }) {
  const [text, setText] = useState(() => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`);
  useEffect(() => {
    setText(new Date(iso).toLocaleString());
  }, [iso]);
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}

function Badge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${BADGE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

function SelfTestCard({ row }: { row: CanaryRow }) {
  const armed = row.status === 'planted' && row.integrity !== 'unreachable';
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${armed ? PANEL_CLASS.ok : PANEL_CLASS.warn}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className={`text-sm font-medium ${armed ? TEXT_CLASS.ok : TEXT_CLASS.warn}`}>
            {armed ? 'Detection chain answered' : 'Detection chain did not answer'}
          </p>
          <p className="mt-0.5 text-xs text-c-muted">
            Each check rewrites one row we own and confirms the trigger recorded it. This is what separates
            &ldquo;nothing happened&rdquo; from &ldquo;nothing is watching&rdquo;.
          </p>
        </div>
        {row.lastCheckedAt && (
          <span className="text-xs text-c-muted">
            <Timestamp iso={row.lastCheckedAt} />
          </span>
        )}
      </div>
    </div>
  );
}

function DecoyTable({ rows }: { rows: CanaryRow[] }) {
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-xl border border-c-line bg-c-card shadow-sm">
        <table className="w-full text-sm">
          <caption className="sr-only">Decoy rows planted in your database</caption>
          <thead>
            <tr className="border-b border-c-line bg-c-soft/60 text-left text-xs uppercase tracking-wider text-c-muted">
              <th scope="col" className="px-4 py-2.5">
                Decoy
              </th>
              <th scope="col" className="px-4">
                Status
              </th>
              <th scope="col" className="px-4">
                Last comparison
              </th>
              <th scope="col" className="px-4">
                Last checked
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-c-line">
            {rows.map((c) => {
              const status = statusLegend(c.status);
              const integrity = integrityLegend(c.integrity);
              return (
                <tr key={c.marker} className="text-c-ink">
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{decoyLabel(c.marker)}</p>
                    <p className="font-mono text-[11px] text-c-muted">{c.marker}</p>
                  </td>
                  <td className="px-4">
                    <Badge tone={status.tone} title={status.meaning}>
                      {status.label}
                    </Badge>
                  </td>
                  <td className="px-4">
                    {integrity ? (
                      <Badge tone={integrity.tone} title={integrity.meaning}>
                        {integrity.label}
                      </Badge>
                    ) : (
                      <span className="text-xs text-c-muted">Not checked yet</span>
                    )}
                  </td>
                  <td className="px-4 text-xs text-c-muted">
                    {c.lastCheckedAt ? <Timestamp iso={c.lastCheckedAt} /> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-c-muted">
        {STATUS_LEGEND_ROWS.map((l) => (
          <span key={l.label} className="inline-flex items-center gap-1.5">
            <Badge tone={l.tone}>{l.label}</Badge>
            {l.meaning}
          </span>
        ))}
      </p>
    </div>
  );
}

function AuditReport({ report, onDismiss }: { report: AnonAuditResult; onDismiss: () => void }) {
  const exposed = report.readable.length > 0;
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${exposed ? PANEL_CLASS.critical : PANEL_CLASS.ok}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-c-ink">Anon-access audit</h3>
        <button onClick={onDismiss} className="text-xs text-c-muted hover:text-c-ink" aria-label="Dismiss audit result">
          Dismiss
        </button>
      </div>

      {exposed ? (
        <div className="mt-2">
          <p className={`text-sm font-medium ${TEXT_CLASS.critical}`}>
            {report.readable.length} table{report.readable.length === 1 ? '' : 's'} answer the public anon key. Anyone
            with your published key can read {report.readable.length === 1 ? 'it' : 'them'} from a browser.
          </p>
          <ul className="mt-1.5 list-inside list-disc font-mono text-xs text-c-ink">
            {report.readable.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={`mt-1 text-sm ${TEXT_CLASS.ok}`}>
          No table answered the anonymous key. Row-level security is holding on everything we could reach.
        </p>
      )}

      {/* The cap and the failures used to be invisible, so a partial audit read
          as a clean bill of health. */}
      <p className="mt-2 text-xs text-c-muted">
        {report.protectedCount} protected · {report.totalTables} table{report.totalTables === 1 ? '' : 's'} found
        {report.unreachable > 0 && ` · ${report.unreachable} did not answer and were not judged`}
        {report.skipped > 0 && ` · ${report.skipped} not tested this run (per-run limit)`}. Only table names are
        recorded; rows are never read.
      </p>
    </div>
  );
}

function EventCard({ event, pending, onReview }: { event: CanaryEventRow; pending: boolean; onReview: () => void }) {
  const legend = eventLegend(event.kind);
  const reviewed = event.acknowledgedAt !== null;
  return (
    <div
      className={`rounded-xl border p-4 shadow-sm transition-colors ${
        reviewed ? 'border-c-line/60 bg-c-soft/40' : legend.tone === 'critical' ? 'border-rose-500/40 bg-c-card' : 'border-amber-500/40 bg-c-card'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className={`text-sm font-medium ${reviewed ? 'text-c-ink' : TEXT_CLASS[legend.tone]}`}>{legend.label}</p>
          {reviewed ? (
            <Badge tone="neutral">
              Reviewed {event.acknowledgedAt ? <Timestamp iso={event.acknowledgedAt} /> : null}
            </Badge>
          ) : (
            <Badge tone={legend.tone}>New</Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-c-muted">
            <Timestamp iso={event.detectedAt} /> · {event.source.replace(/_/g, ' ')}
          </span>
          {!reviewed && (
            <button
              onClick={onReview}
              disabled={pending}
              className="rounded-lg border border-c-line bg-c-card px-2 py-0.5 text-xs font-medium text-c-muted shadow-sm hover:border-c-line/80 hover:text-c-ink disabled:opacity-50"
            >
              Mark reviewed
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-c-muted">{event.detail}</p>
      <p className="mt-1 text-xs text-c-muted/70">{legend.meaning}</p>
    </div>
  );
}

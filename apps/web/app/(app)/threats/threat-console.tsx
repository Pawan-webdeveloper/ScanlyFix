'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import {
  clearTestAttacksAction,
  refreshThreatsAction,
  sendTestAttackAction,
  type ThreatFeedRow,
  type ThreatSnapshot,
} from './actions';
import { SEVERITY_RANK, WINDOW_HOURS, surfaceLabel, threatMeta } from '@/lib/runtime/threats/labels';

/** How often the feed asks for new events while live mode is on. */
const POLL_MS = 10_000;

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium';

const SEVERITY_TEXT: Record<string, string> = {
  critical: 'text-rose-600 dark:text-rose-400',
  high: 'text-amber-700 dark:text-amber-400',
  medium: 'text-sky-600 dark:text-sky-400',
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  high: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  medium: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
};

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-rose-500',
  high: 'bg-amber-500',
  medium: 'bg-sky-500',
};

export function ThreatConsole(props: {
  projectId: string;
  projectName: string;
  /** Whether this project has ever received anything at all from the SDK. */
  sdkConnected: boolean;
  initial: ThreatSnapshot;
}) {
  const [snapshot, setSnapshot] = useState<ThreatSnapshot>(props.initial);
  const [live, setLive] = useState(true);
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);

  // A ref, not state: the poll reads it without needing to be torn down and
  // rebuilt every time a request is in flight.
  const inFlight = useRef(false);

  const refresh = useCallback(
    async (showSpinner: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (showSpinner) setRefreshing(true);
      try {
        const res = await refreshThreatsAction(props.projectId);
        if (res.ok) setSnapshot(res.data);
        else setNotice({ tone: 'error', text: res.error });
      } catch {
        // A failed poll is not worth interrupting the reader over; the next one
        // in ten seconds will either work or the page is already broken.
      } finally {
        inFlight.current = false;
        setRefreshing(false);
      }
    },
    [props.projectId],
  );

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      // Polling a tab nobody is looking at is pure waste, and on a phone it is
      // waste that costs battery.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void refresh(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  const events = useMemo(() => {
    const rows = severity === 'all' ? snapshot.events : snapshot.events.filter((e) => e.severity === severity);
    return [...rows].sort((a, b) => {
      const byTime = b.detectedAt.localeCompare(a.detectedAt);
      if (byTime !== 0) return byTime;
      return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    });
  }, [snapshot.events, severity]);

  const hasSamples = snapshot.events.some((e) => e.source === 'sample');
  const { totals } = snapshot;

  function runTestAttack() {
    startTransition(async () => {
      const res = await sendTestAttackAction(props.projectId);
      if (res.ok) {
        setNotice({
          tone: 'ok',
          text: `${res.data.recorded} test attacks were run through the real detector and recorded. They are marked "Test" and you can clear them at any time.`,
        });
        await refresh(true);
      } else {
        setNotice({ tone: 'error', text: res.error });
      }
    });
  }

  function clearTestAttacks() {
    startTransition(async () => {
      const res = await clearTestAttacksAction(props.projectId);
      if (res.ok) {
        setNotice({ tone: 'ok', text: `${res.data.removed} test events removed.` });
        await refresh(true);
      } else {
        setNotice({ tone: 'error', text: res.error });
      }
    });
  }

  const quiet = totals.total === 0;

  return (
    <div className="space-y-6">
      {/* ── HEADLINE ─────────────────────────────────────────────────────── */}
      <div
        className={`rounded-xl border p-5 shadow-sm ${
          totals.critical > 0
            ? 'border-rose-500/40 bg-rose-500/5'
            : !props.sdkConnected
              ? 'border-c-line bg-c-card'
              : 'border-emerald-500/30 bg-emerald-500/5'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p
              className={`text-sm font-semibold ${
                totals.critical > 0
                  ? SEVERITY_TEXT.critical
                  : !props.sdkConnected
                    ? 'text-c-ink'
                    : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {!props.sdkConnected
                ? 'Not receiving traffic yet'
                : totals.critical > 0
                  ? `${totals.critical} serious attack${totals.critical === 1 ? '' : 's'} on ${props.projectName} in the last ${WINDOW_HOURS} hours`
                  : quiet
                    ? 'Watching — nothing has been thrown at your site'
                    : `${totals.total} attack attempt${totals.total === 1 ? '' : 's'}, none of them serious`}
            </p>
            <p className="mt-1 max-w-2xl text-sm text-c-muted">
              {!props.sdkConnected
                ? 'Add the middleware below and deploy. Every request to your live site is then checked as it arrives — nothing is proxied through us and nothing is slowed down.'
                : 'Every request to your live site is checked as it arrives. Only what matched is recorded, and only the payload — never your users’ data.'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh(true)}
              disabled={refreshing}
              className="inline-flex h-7 items-center rounded-lg border border-c-line bg-c-card px-2.5 text-xs font-medium text-c-muted shadow-sm hover:text-c-ink disabled:opacity-50"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              onClick={() => setLive((v) => !v)}
              aria-pressed={live}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-sm transition-colors ${
                live
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-c-line bg-c-card text-c-muted hover:text-c-ink'
              }`}
            >
              {live && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
              )}
              {live ? 'Live' : 'Paused'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Critical" value={totals.critical} tone="critical" />
          <Stat label="High" value={totals.high} tone="high" />
          <Stat label="Medium" value={totals.medium} tone="medium" />
          <Stat label="Blocked by you" value={totals.blocked} tone="neutral" />
        </div>
      </div>

      {notice && (
        <p
          className={`rounded-lg border px-4 py-2.5 text-sm ${
            notice.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400'
              : 'border-rose-500/40 bg-rose-500/5 text-rose-600 dark:text-rose-400'
          }`}
          role="status"
        >
          {notice.text}
        </p>
      )}

      {/* ── PASSWORD GUESSING ────────────────────────────────────────────── */}
      {snapshot.bruteForce.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-c-muted">Sign-in pressure</h2>
          {snapshot.bruteForce.map((f) => (
            <div
              key={`${f.sourceIp ?? 'unknown'}-${f.lastSeen}`}
              className={`rounded-xl border p-4 shadow-sm ${
                f.confidence === 'certain' ? 'border-rose-500/40 bg-rose-500/5' : 'border-amber-500/30 bg-amber-500/5'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={`text-sm font-medium ${f.confidence === 'certain' ? SEVERITY_TEXT.critical : SEVERITY_TEXT.high}`}>
                  {f.headline}
                </p>
                {f.sourceIp && <CopyButton value={f.sourceIp} label="Copy address" />}
              </div>
              <p className="mt-1 text-sm text-c-muted">{f.detail}</p>
              <p className="mt-1.5 text-xs text-c-muted/80">{threatMeta('brute_force').action}</p>
            </div>
          ))}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* ── FEED ───────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-c-muted">
              Attack feed <span className="text-c-muted/70">· last {WINDOW_HOURS}h</span>
            </h2>
            <div className="flex items-center gap-1 rounded-lg border border-c-line bg-c-card p-0.5">
              {(
                [
                  ['all', `All${totals.total ? ` (${totals.total})` : ''}`],
                  ['critical', `Critical${totals.critical ? ` (${totals.critical})` : ''}`],
                  ['high', `High${totals.high ? ` (${totals.high})` : ''}`],
                  ['medium', `Medium${totals.medium ? ` (${totals.medium})` : ''}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSeverity(key)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    severity === key ? 'bg-c-accent text-white' : 'text-c-muted hover:text-c-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {events.length === 0 ? (
            <EmptyFeed
              quiet={quiet}
              filtered={!quiet && severity !== 'all'}
              connected={props.sdkConnected}
              pending={pending}
              onTest={runTestAttack}
            />
          ) : (
            <ul className="space-y-2.5">
              {events.map((e) => (
                <EventCard
                  key={e.id}
                  event={e}
                  open={expanded === e.id}
                  onToggle={() => setExpanded((cur) => (cur === e.id ? null : e.id))}
                />
              ))}
            </ul>
          )}

          {hasSamples && (
            <button
              onClick={clearTestAttacks}
              disabled={pending}
              className="w-full rounded-lg border border-c-line bg-c-card px-4 py-2 text-xs font-medium text-c-muted shadow-sm hover:text-c-ink disabled:opacity-50"
            >
              Clear the test events
            </button>
          )}
        </section>

        {/* ── SIDEBAR ────────────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <Panel title="Where it is coming from">
            {snapshot.sources.length === 0 ? (
              <p className="text-xs text-c-muted">No addresses recorded yet.</p>
            ) : (
              <ul className="space-y-2">
                {snapshot.sources.map((s) => (
                  <li key={s.sourceIp} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-c-ink">{s.sourceIp}</p>
                      <p className="text-[11px] text-c-muted">
                        {s.count} request{s.count === 1 ? '' : 's'}
                        {s.kinds > 0 && ` · ${s.kinds} attack type${s.kinds === 1 ? '' : 's'}`}
                        {s.blocked > 0 && ` · ${s.blocked} your app turned away`}
                      </p>
                    </div>
                    <CopyButton value={s.sourceIp} label="Copy" />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[11px] text-c-muted/80">
              Block these at your CDN or host — a request stopped there never reaches your app and costs you nothing.
            </p>
          </Panel>

          <Panel title="What they are aiming at">
            {snapshot.targets.length === 0 ? (
              <p className="text-xs text-c-muted">No routes targeted yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {snapshot.targets.map((t) => (
                  <li key={t.key} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs text-c-ink">{t.key}</span>
                    <span className="shrink-0 text-[11px] text-c-muted">×{t.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="What this can and cannot see">
            <ul className="space-y-2 text-xs text-c-muted">
              <li>
                <strong className="text-c-ink">Detection, not blocking.</strong> Your app decides what to do with a
                request; we record what was attempted. Nothing is proxied through us, so we cannot slow your site down or
                take it offline.
              </li>
              <li>
                <strong className="text-c-ink">Payloads, not user data.</strong> We read the path, the query string, the
                user agent and a short list of headers. Never a request body, never a cookie, never an authorization
                header.
              </li>
              <li>
                <strong className="text-c-ink">Recognised attacks only.</strong> The rules are deliberately strict, so a
                targeted attack written for your app specifically can slip past. A feed you can trust completely is worth
                more than one that catches slightly more and cries wolf.
              </li>
              <li>
                <strong className="text-c-ink">Sign-ins are counted, not judged.</strong> Middleware runs before your
                login handler, so we see attempts and not outcomes. Call{' '}
                <code className="rounded bg-c-soft px-1">reportAuthFailure(req)</code> in your handler and we can tell
                real password guessing from a busy office.
              </li>
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-c-line bg-c-card px-3 py-2 shadow-sm">
      <p className={`text-xl font-semibold ${value > 0 ? (SEVERITY_TEXT[tone] ?? 'text-c-ink') : 'text-c-muted'}`}>
        {value}
      </p>
      <p className="text-[11px] uppercase tracking-wider text-c-muted">{label}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-c-line bg-c-card p-4 shadow-sm">
      <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-c-muted">{title}</h3>
      {children}
    </div>
  );
}

function EventCard({ event, open, onToggle }: { event: ThreatFeedRow; open: boolean; onToggle: () => void }) {
  const meta = threatMeta(event.kind);
  const badge = SEVERITY_BADGE[event.severity] ?? SEVERITY_BADGE.medium!;
  const dot = SEVERITY_DOT[event.severity] ?? SEVERITY_DOT.medium!;

  return (
    <li className="rounded-xl border border-c-line bg-c-card shadow-sm">
      <button onClick={onToggle} aria-expanded={open} className="w-full px-4 py-3 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="text-sm font-medium text-c-ink">{meta.label}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge}`}>{event.severity}</span>
          {event.confidence === 'likely' && (
            <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted" title="Strong match, but this pattern has a rare legitimate use.">
              likely
            </span>
          )}
          {event.blocked && (
            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              your app blocked it
            </span>
          )}
          {event.source === 'sample' && (
            <span className="rounded bg-c-soft px-1.5 py-0.5 text-[10px] font-medium text-c-muted">Test</span>
          )}
          <span className="ml-auto text-xs text-c-muted">
            <RelativeTime iso={event.detectedAt} />
          </span>
        </div>

        <p className="mt-1.5 text-xs text-c-muted">
          <span className="font-mono text-c-ink">
            {event.method} {event.pattern}
          </span>
          {' · '}
          {surfaceLabel(event.surface)}
          {event.sourceIp && (
            <>
              {' · from '}
              <span className="font-mono">{event.sourceIp}</span>
            </>
          )}
        </p>

        {event.evidence && (
          <pre className="mt-2 overflow-x-auto rounded-lg border border-c-line bg-c-soft/60 px-2.5 py-1.5 font-mono text-[11px] text-c-ink">
            {event.evidence}
          </pre>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-c-line px-4 py-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-c-muted">What they tried</p>
            <p className="mt-0.5 text-sm text-c-muted">{meta.meaning}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-c-muted">What to do</p>
            <p className="mt-0.5 text-sm text-c-muted">{meta.action}</p>
          </div>
          {event.userAgent && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-c-muted">Sent by</p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-c-muted">{event.userAgent}</p>
            </div>
          )}
          <p className="text-[11px] text-c-muted/70">
            Recorded <AbsoluteTime iso={event.detectedAt} />
            {event.responseStatus !== null && ` · your app answered ${event.responseStatus}`}
          </p>
        </div>
      )}
    </li>
  );
}

function EmptyFeed({
  quiet,
  filtered,
  connected,
  pending,
  onTest,
}: {
  quiet: boolean;
  filtered: boolean;
  connected: boolean;
  pending: boolean;
  onTest: () => void;
}) {
  if (filtered) {
    return (
      <div className="rounded-xl border border-c-line bg-c-card p-6 text-center shadow-sm">
        <p className="text-sm text-c-muted">Nothing at this severity in the last {WINDOW_HOURS} hours.</p>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border p-6 text-center shadow-sm ${
        connected ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-c-line bg-c-card'
      }`}
    >
      <p className={`text-sm font-medium ${connected ? 'text-emerald-600 dark:text-emerald-400' : 'text-c-ink'}`}>
        {connected ? 'Nothing has been thrown at your site yet.' : 'Waiting for your first request.'}
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-c-muted">
        {connected
          ? 'That is the normal state, and a quiet feed here is the good outcome. Most sites see their first config-hunting scan within a day of going public.'
          : 'Once the middleware is deployed, anything thrown at your site shows up here within a few seconds.'}
      </p>
      <button
        onClick={onTest}
        disabled={pending}
        className="mt-4 inline-flex h-8 items-center justify-center rounded-lg border border-c-line bg-c-card px-3 text-xs font-medium text-c-ink shadow-sm hover:bg-c-soft disabled:opacity-50"
      >
        {pending ? 'Running…' : 'Run a test attack'}
      </button>
      <p className="mx-auto mt-2 max-w-md text-[11px] text-c-muted/80">
        Runs six real attack payloads through the same detector your site uses, so you can see what a detection looks
        like. Nothing is sent to your site, and the results are marked and removable.
      </p>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          },
          () => {
            // Clipboard denied outside a secure context — the value is on screen.
          },
        );
      }}
      className="inline-flex h-6 shrink-0 items-center rounded border border-c-line bg-c-card px-2 text-[10px] font-medium text-c-muted hover:bg-c-soft hover:text-c-ink"
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

/**
 * Times the reader can trust.
 *
 * These render on the server too, where the locale and time zone are the
 * machine's rather than the reader's. Formatting only after mount keeps both
 * renders identical and still shows the time in the reader's own zone.
 */
function useClientText(iso: string, format: (d: Date) => string, fallback: string): string {
  const [text, setText] = useState(fallback);
  useEffect(() => {
    const update = () => setText(format(new Date(iso)));
    update();
    // A relative time that says "2m ago" for an hour is worse than no relative
    // time at all, and a live feed is exactly where someone leaves a tab open.
    const timer = setInterval(update, 30_000);
    return () => clearInterval(timer);
  }, [iso, format]);
  return text;
}

function relative(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function RelativeTime({ iso }: { iso: string }) {
  const text = useClientText(iso, relative, `${iso.slice(11, 16)} UTC`);
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}

function AbsoluteTime({ iso }: { iso: string }) {
  const text = useClientText(iso, (d) => d.toLocaleString(), `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`);
  return <time dateTime={iso}>{text}</time>;
}

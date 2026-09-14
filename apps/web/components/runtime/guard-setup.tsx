'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { getOrCreateRuntimeSecretAction, rotateRuntimeSecretAction, simulateSampleTrafficAction } from '@/app/(app)/runtime/guard/actions';

/**
 * The snippet that matters. `withGuard(myMiddleware)` is what lets Guard record
 * what the middleware DID with each request, so the wrapped form is what the
 * setup card teaches — the bare form is offered second.
 */
const SETUP_SNIPPET = `// middleware.ts
import { withGuard } from '@scanlyfix/runtime-sdk';
import { auth } from '@/lib/auth'; // your existing middleware

// Wrapping your auth middleware lets Guard record whether logged-out
// requests were turned away — not just that they arrived.
export default withGuard(auth);

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};`;

const BARE_SNIPPET = `// No middleware of your own yet? This still builds the route inventory.
export default withGuard();`;

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {
            /* clipboard denied — the text is on screen either way */
          },
        );
      }}
      className="inline-flex h-6 shrink-0 items-center justify-center rounded border border-c-line bg-c-card px-2 text-[10px] font-medium text-c-muted transition-colors hover:bg-c-soft hover:text-c-ink"
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function SdkKeysCard({ projectId, origin }: { projectId: string; origin: string }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotating, startRotate] = useTransition();
  const [rotateWarning, setRotateWarning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getOrCreateRuntimeSecretAction(projectId).then((res) => {
      if (cancelled) return;
      if (res.ok) setSecret(res.secret);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const ingestUrl = `${origin}/api/runtime/ingest`;
  const envBlock = [
    `RUNTIME_PROJECT_ID=${projectId}`,
    `RUNTIME_INGEST_URL=${ingestUrl}`,
    `RUNTIME_SIGNING_SECRET=${secret ?? '<loading…>'}`,
  ].join('\n');

  function handleRotate() {
    const confirmed = confirm(
      'Regenerate signing secret?\n\nYour SDK instances will receive 401 errors until you update RUNTIME_SIGNING_SECRET in your environment and redeploy. The previous secret keeps working for 24 hours.',
    );
    if (!confirmed) return;
    setRotateWarning(false);
    startRotate(async () => {
      const res = await rotateRuntimeSecretAction(projectId);
      if (res.ok) {
        setSecret(res.secret);
        setRotateWarning(true);
        setTimeout(() => setRotateWarning(false), 8000);
      }
    });
  }

  const rows: Array<{ name: string; value: string | null; mask?: boolean }> = [
    { name: 'RUNTIME_PROJECT_ID', value: projectId },
    { name: 'RUNTIME_INGEST_URL', value: ingestUrl },
    { name: 'RUNTIME_SIGNING_SECRET', value: secret, mask: true },
  ];

  return (
    <div className="rounded-xl border border-c-line bg-c-card shadow-sm">
      <div className="flex items-center justify-between border-b border-c-line px-5 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-c-muted">SDK environment variables</h3>
        <div className="flex items-center gap-2">
          {secret && <CopyButton text={envBlock} label="Copy all" />}
          <button
            type="button"
            onClick={handleRotate}
            disabled={rotating || loading}
            className="inline-flex h-6 items-center justify-center rounded border border-rose-200 px-2 text-[10px] font-medium text-rose-500 transition-colors hover:bg-rose-50 disabled:opacity-40 dark:border-rose-800 dark:hover:bg-rose-950"
          >
            {rotating ? 'Rotating…' : 'Regenerate'}
          </button>
        </div>
      </div>

      <div className="divide-y divide-c-line">
        {rows.map((row) => (
          <div key={row.name} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-c-muted">{row.name}</p>
              {row.mask && loading ? (
                <p className="mt-0.5 animate-pulse font-mono text-xs text-c-muted">Generating…</p>
              ) : row.value ? (
                <p className="mt-0.5 truncate font-mono text-xs text-c-ink">{row.value}</p>
              ) : (
                <p className="mt-0.5 font-mono text-xs text-rose-500">Failed to load — refresh the page</p>
              )}
            </div>
            {row.value && <CopyButton text={row.value} />}
          </div>
        ))}
      </div>

      <div className="border-t border-c-line px-5 py-3">
        <p className="text-[11px] text-c-muted">
          <span className="font-semibold text-amber-600 dark:text-amber-400">Keep secret:</span> put these in your app&rsquo;s{' '}
          <code className="rounded bg-c-soft px-1 font-mono text-[10px]">.env.local</code> or your host&rsquo;s environment
          settings. Never commit <code className="rounded bg-c-soft px-1 font-mono text-[10px]">RUNTIME_SIGNING_SECRET</code>.
        </p>
        {rotateWarning && (
          <p className="mt-2 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
            Secret rotated. Update it in your app and redeploy within 24 hours — after that the old secret stops working.
          </p>
        )}
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <p className="mb-1.5 text-xs font-semibold text-c-muted">
        Step {n} — {title}
      </p>
      {children}
    </div>
  );
}

/**
 * Setup instructions in a section that stays closed until asked for.
 *
 * The credentials block is rendered only once it is opened: mounting it eagerly
 * would fetch the project's signing secret and put it in the DOM on every visit
 * to the Guard page, for every viewer, whether or not anyone wanted to see it.
 */
export function CollapsibleGuardSetup({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-xl border border-c-line bg-c-card p-5 shadow-sm"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-sm font-medium text-c-ink">Setup &amp; SDK credentials</summary>
      {open && (
        <div className="mt-4">
          <GuardSetupCard projectId={projectId} showSimulate={false} />
        </div>
      )}
    </details>
  );
}

export function GuardSetupCard({ projectId, showSimulate = true }: { projectId: string; showSimulate?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [origin, setOrigin] = useState('https://scanlyfix.com');
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  function handleSimulate() {
    setMsg(null);
    startTransition(async () => {
      const res = await simulateSampleTrafficAction(projectId);
      if (res.ok) {
        setMsg({ text: `Seeded ${res.seededRoutes} sample routes. They are labelled and never raise findings.` });
        router.refresh();
      } else {
        setMsg({ text: `Could not seed sample traffic: ${res.error}`, error: true });
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-base font-semibold text-c-ink">Nothing has reported in from your app yet</h3>
            <p className="mt-1 max-w-2xl text-sm text-c-muted">
              Guard is a middleware wrapper. Once it is installed, this page lists every route and server action your app
              actually serves, which of them only signed-in users reach, and what your middleware does when someone
              logged-out knocks.
            </p>
          </div>
          {showSimulate && (
            <button
              type="button"
              onClick={handleSimulate}
              disabled={pending}
              className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-c-accent px-3 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {pending ? 'Seeding…' : 'Show me with sample data'}
            </button>
          )}
        </div>
        {msg && (
          <p
            className={`mt-3 text-xs font-medium ${msg.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}
          >
            {msg.text}
          </p>
        )}

        <Step n={1} title="Install the SDK in your Next.js app">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="sr-only">Install command</span>
            <CopyButton text="npm install @scanlyfix/runtime-sdk" />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">
            npm install @scanlyfix/runtime-sdk
          </pre>
        </Step>

        <Step n={2} title="Wrap your middleware">
          <div className="mb-1 flex items-center justify-end">
            <CopyButton text={SETUP_SNIPPET} />
          </div>
          <pre className="overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">
            {SETUP_SNIPPET}
          </pre>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-dashed border-c-line bg-c-soft/60 p-3 font-mono text-[11px] text-c-muted">
            {BARE_SNIPPET}
          </pre>
        </Step>

        <Step n={3} title="Set environment variables">
          <p className="mb-2 text-[11px] text-c-muted">
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">Deployed already?</span> You can leave{' '}
            <code className="rounded bg-c-soft px-1 font-mono text-[10px]">RUNTIME_PROJECT_ID</code> out — the project is
            matched from the request&rsquo;s domain. The signing secret is still required; it is the only thing that
            authenticates your app.
          </p>
          <SdkKeysCard projectId={projectId} origin={origin} />
        </Step>
      </div>

      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-c-ink">What leaves your app</h3>
        <ul className="mt-3 space-y-2 text-sm text-c-muted">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <span>
              Route patterns, normalised to their file-tree shape (<code className="font-mono text-xs text-c-ink">/api/users/[id]</code>) —
              ids, emails and tokens are replaced before the event is built
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <span>HTTP method, whether it was a server action, and whether a session cookie was present</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <span>The status your middleware returned, so &ldquo;was this request turned away?&rdquo; can be answered</span>
          </li>
          <li className="flex items-start gap-2 text-rose-500">
            <span className="mt-0.5">✗</span>
            <span>Never: request or response bodies, header values, cookie values, query strings, or the session token itself</span>
          </li>
        </ul>
        <p className="mt-3 text-xs text-c-muted">
          Reporting is queued and flushed in the background. Guard never blocks a request, and an error inside it can
          never fail one.
        </p>
      </div>
    </div>
  );
}

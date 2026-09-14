'use client';

import { CopyButton } from '@/components/runtime/guard-setup';

/**
 * How to switch threat detection on.
 *
 * Deliberately short, because for most people the answer is "you already did".
 * Live Threats rides on the same `withGuard` middleware Guard Routes uses and
 * the same three environment variables — there is no second SDK, no second key,
 * and no second deploy. Saying so plainly is worth more than a setup wizard that
 * re-teaches something already installed.
 */

const MIDDLEWARE = `// middleware.ts
import { withGuard } from '@scanlyfix/runtime-sdk';
import { auth } from '@/lib/auth'; // your existing middleware, if you have one

// Threat detection is on by default. Pass { threats: false } to turn it off.
export default withGuard(auth);

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};`;

const AUTH_FAILURE = `// app/api/login/route.ts
import { reportAuthFailure } from '@scanlyfix/runtime-sdk';

export async function POST(req: Request) {
  const user = await verifyCredentials(await req.json());
  if (!user) {
    reportAuthFailure(req);   // optional — turns "attempts" into "failures"
    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
  }
  // …
}`;

export function ThreatSetupCard() {
  return (
    <div className="space-y-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 shadow-sm">
      <div>
        <h3 className="text-base font-semibold text-c-ink">Nothing has reported in from your site yet</h3>
        <p className="mt-1 max-w-3xl text-sm text-c-muted">
          Threat detection is part of the same middleware as Guard Routes. If you have already installed it, deploy once
          more to pick up the newest SDK and attacks will start appearing here within seconds. If not, this is the whole
          installation.
        </p>
      </div>

      <Snippet
        step={1}
        title="Wrap your middleware"
        body="Detection runs in-process on the request your app already received. No traffic is proxied through us, so we cannot slow your site down or take it offline."
        code={MIDDLEWARE}
      />

      <Snippet
        step={2}
        title="Optional — tell us when a sign-in fails"
        body="Middleware runs before your login handler, so on its own this feature can count sign-in attempts but not judge them. One line inside the handler is the difference between “412 attempts from this address” and “17 failed passwords from this address”."
        code={AUTH_FAILURE}
      />

      <p className="text-xs text-c-muted">
        Your project id, ingest URL and signing secret are in the panel below — the same three values Guard Routes uses.
      </p>
    </div>
  );
}

function Snippet({ step, title, body, code }: { step: number; title: string; body: string; code: string }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-c-accent text-[10px] font-semibold text-white">
          {step}
        </span>
        <h4 className="text-sm font-medium text-c-ink">{title}</h4>
      </div>
      <p className="mt-1 max-w-3xl pl-7 text-xs text-c-muted">{body}</p>
      <div className="mt-2 pl-7">
        <div className="mb-1 flex justify-end">
          <CopyButton text={code} />
        </div>
        <pre className="overflow-x-auto rounded-lg border border-c-line bg-c-card p-3 font-mono text-[11px] leading-relaxed text-c-ink">
          {code}
        </pre>
      </div>
    </div>
  );
}

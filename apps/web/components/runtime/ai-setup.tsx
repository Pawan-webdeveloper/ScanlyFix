'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { sendSampleAiCallAction } from '@/app/(app)/runtime/ai/actions.ts';
import {
  SAMPLE_SCENARIOS,
  SAMPLE_SCENARIO_HINT,
  SAMPLE_SCENARIO_LABEL,
  type SampleScenario,
} from '@/lib/runtime/ai-spend/sample.ts';
import { CopyButton } from './guard-setup.tsx';

type Provider = 'openai' | 'anthropic';

const PROVIDER_LABEL: Readonly<Record<Provider, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function snippet(provider: Provider, origin: string): string {
  const isOpenAi = provider === 'openai';
  const wrap = isOpenAi ? 'wrapOpenAI' : 'wrapAnthropic';
  const clientImport = isOpenAi ? "import OpenAI from 'openai';" : "import Anthropic from '@anthropic-ai/sdk';";
  const client = isOpenAi ? 'new OpenAI()' : 'new Anthropic()';
  const exported = isOpenAi ? 'openai' : 'anthropic';

  return `import {
  createRuntime, ${wrap},
  SpendFirewall, MemorySpendStore, createRemoteConfigFetcher,
} from '@scanlyfix/runtime-sdk';
${clientImport}

const runtime = createRuntime({
  projectId: process.env.RUNTIME_PROJECT_ID!,
  ingestUrl: process.env.RUNTIME_INGEST_URL ?? '${origin}/api/runtime/ingest',
  signingSecret: process.env.RUNTIME_SIGNING_SECRET,
});

// The ceiling is read from the dashboard every 5 minutes — no redeploy to change it.
const firewall = new SpendFirewall({
  projectId: process.env.RUNTIME_PROJECT_ID!,
  store: new MemorySpendStore(), // Several instances? Use createUpstashStore(url, token)
  configFetcher: createRemoteConfigFetcher({
    configUrl: process.env.RUNTIME_CONFIG_URL ?? '${origin}/api/runtime/config',
    projectId: process.env.RUNTIME_PROJECT_ID!,
    signingSecret: process.env.RUNTIME_SIGNING_SECRET,
  }),
});

export const ${exported} = ${wrap}(${client}, {
  runtime,
  firewall,
  // Hashed one-way on your server; the raw id never leaves your process.
  // Without it a runaway loop cannot be traced to the job causing it.
  getUserId: () => session?.user?.id,
});`;
}

export function AiSetupCard({ projectId, hasCalls = false }: { projectId: string; hasCalls?: boolean }) {
  const router = useRouter();
  const [provider, setProvider] = useState<Provider>('openai');
  const [scenario, setScenario] = useState<SampleScenario>('mixed');
  const [origin, setOrigin] = useState('https://scanlyfix.com');
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin);
  }, []);

  function seed() {
    setMsg(null);
    startTransition(async () => {
      const res = await sendSampleAiCallAction(projectId, scenario);
      setMsg(res.ok ? { text: res.message ?? 'Seeded.' } : { text: res.error, error: true });
      if (res.ok) router.refresh();
    });
  }

  const code = snippet(provider, origin);
  const env = `RUNTIME_PROJECT_ID=${projectId}
RUNTIME_INGEST_URL=${origin}/api/runtime/ingest
RUNTIME_CONFIG_URL=${origin}/api/runtime/config
# Optional: a local ceiling that overrides the dashboard value
# RUNTIME_SPEND_CEILING_USD_PER_HOUR=5`;

  return (
    <div className="space-y-6">
      <div className={`rounded-xl border p-6 shadow-sm ${hasCalls ? 'border-c-line bg-c-card' : 'border-amber-500/20 bg-amber-500/5'}`}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              {!hasCalls && (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                </span>
              )}
              <h3 className="text-base font-semibold text-c-ink">
                {hasCalls ? 'SDK integration' : 'No AI telemetry yet'}
              </h3>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-c-muted">
              A wrapper around your existing client, not a proxy. Your API key stays in your process, requests go straight to the
              provider, and only metadata leaves — model, token counts, latency, and whether the call succeeded.
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
            <div className="flex items-center gap-1.5">
              <select
                value={scenario}
                onChange={(e) => setScenario(e.target.value as SampleScenario)}
                aria-label="Sample data scenario"
                className="h-8 rounded-lg border border-c-line bg-c-card px-2 text-xs text-c-ink focus:outline-none focus:ring-1 focus:ring-c-accent"
              >
                {SAMPLE_SCENARIOS.map((s) => (
                  <option key={s} value={s}>
                    {SAMPLE_SCENARIO_LABEL[s]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={seed}
                disabled={pending}
                className="inline-flex h-8 items-center rounded-lg bg-c-accent px-3 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {pending ? 'Seeding…' : 'Seed sample data'}
              </button>
            </div>
            <span className="max-w-[16rem] text-right text-[11px] text-c-muted">{SAMPLE_SCENARIO_HINT[scenario]}</span>
            {msg && (
              <span className={`text-xs font-medium ${msg.error ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                {msg.text}
              </span>
            )}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProvider(p)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  provider === p ? 'bg-c-accent text-white shadow-sm' : 'border border-c-line bg-c-card text-c-muted hover:text-c-ink'
                }`}
              >
                {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
          <CopyButton text={code} />
        </div>

        <pre className="mt-3 overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3.5 font-mono text-xs text-c-ink">{code}</pre>

        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-c-muted">Environment variables</p>
          <CopyButton text={env} />
        </div>
        <pre className="mt-1 overflow-x-auto rounded-lg border border-c-line bg-c-soft p-3 font-mono text-xs text-c-ink">{env}</pre>
      </div>

      <div className="rounded-xl border border-c-line bg-c-card p-6 shadow-sm">
        <h3 className="text-base font-semibold text-c-ink">What this gives you</h3>
        <ul className="mt-3 space-y-2 text-sm text-c-muted">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <span>
              <strong className="text-c-ink">A hard stop, not a notification.</strong> Each call&rsquo;s projected cost is reserved
              before the request is sent; crossing the ceiling throws and the provider is never called.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <span>
              <strong className="text-c-ink">Spike detection against your own normal.</strong> A project that usually spends cents
              an hour is alerted on a fivefold jump, not on reaching some fixed figure it would never hit.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <span>
              <strong className="text-c-ink">Failures counted too.</strong> Rate limits, auth rejections, timeouts and ceiling
              refusals are recorded at zero cost, so an error rate is visible without a log search.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-500">✓</span>
            <span>
              <strong className="text-c-ink">Streaming passes through untouched.</strong> Chunks are read, never altered, and usage
              is taken from the final event in a finally block — an abandoned stream is still accounted for.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-rose-500">✗</span>
            <span>
              <strong className="text-c-ink">Never collected:</strong> prompts, completions, system messages, tool arguments, API
              keys, or provider error messages — those echo request content back, so only a fixed failure label is stored.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

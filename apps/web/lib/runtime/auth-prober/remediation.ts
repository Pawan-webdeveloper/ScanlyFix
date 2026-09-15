import { CATEGORY_LABEL, categorizePath } from './targets';
import type { FindingVariant, ProbeEvidence, TargetCategory } from './types';

export type Remediation = {
  /** One-line headline, e.g. "Admin panel reachable without login". */
  title: string;
  /** Why it matters, in plain language. */
  impact: string;
  /** Concrete steps in order. */
  steps: string[];
  /** Copy-paste prompt for Claude / Cursor / Windsurf — the CheckVibe-style "AI-ready fix". */
  fixPrompt: string;
};

export type RemediationInput = {
  path: string;
  variant?: FindingVariant;
  category?: TargetCategory | null;
  baselineStatus?: number | null;
  actualStatus: number;
  evidence?: ProbeEvidence | null;
  keyFingerprint?: string | null;
};

function evidenceLines(e: ProbeEvidence | null | undefined, status: number): string[] {
  const lines = [`HTTP ${status}`];
  if (!e) return lines;
  if (e.contentType) lines.push(`Content-Type: ${e.contentType}`);
  lines.push(`Body: ${e.bodyBytes} bytes (${e.bodyKind.replace('_', ' ')})`);
  if (e.title) lines.push(`Title: ${e.title}`);
  if (e.bodySample) lines.push(`Sample: ${e.bodySample.slice(0, 160)}`);
  return lines;
}

function guardSteps(category: TargetCategory): string[] {
  switch (category) {
    case 'api':
      return [
        'Verify the session/token at the top of the route handler and return 401 before touching any data.',
        'Add the route to your auth middleware matcher so the check cannot be forgotten on the next refactor.',
        'If the backend is Supabase/PostgREST, enable RLS on the table and write a policy scoped to auth.uid().',
      ];
    case 'admin':
      return [
        'Require an authenticated session with an admin role in middleware for the whole /admin (or equivalent) prefix.',
        'Redirect logged-out visitors to the sign-in page instead of rendering the panel.',
        'Audit the panel for actions that were reachable while it was open (user changes, exports, settings).',
      ];
    case 'debug':
      return [
        'Disable or remove the endpoint in production builds — gate it on NODE_ENV or a feature flag that is off in prod.',
        'If it must stay, put it behind authentication and an IP allow-list.',
        'Check what it disclosed (env vars, stack traces, internal URLs) and rotate anything sensitive.',
      ];
    case 'auth_page':
      return [
        'Check the session in the page loader / middleware and redirect logged-out visitors to sign-in.',
        'Make sure the redirect happens on the server — a client-side redirect still leaks the server-rendered HTML.',
      ];
  }
}

export function buildRemediation(input: RemediationInput): Remediation {
  const category = input.category ?? categorizePath(input.path);
  const label = CATEGORY_LABEL[category];
  const ev = evidenceLines(input.evidence, input.actualStatus).join('\n');
  const variant = input.variant ?? null;

  if (variant === 'anon_role') {
    const steps = [
      'Enable Row Level Security on every table this endpoint reads: ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;',
      'Add SELECT policies scoped to the signed-in user, e.g. USING (auth.uid() = user_id).',
      'Remove any policy that grants the anon role unrestricted SELECT (look for "TO anon USING (true)").',
      'Re-run the prober — the finding auto-resolves once the anon key is rejected.',
    ];
    return {
      title: `${input.path} readable with the public Supabase anon key`,
      impact:
        'The anon key ships in your frontend bundle, so anyone can copy it. Without RLS every row this endpoint returns is public data.',
      steps,
      fixPrompt: [
        `Security finding: ${input.path} returns HTTP ${input.actualStatus} when called with our public Supabase anon key (fingerprint ${input.keyFingerprint ?? 'n/a'}), even though it returns ${input.baselineStatus ?? 'a protected status'} without any key.`,
        `Evidence:\n${ev}`,
        'Fix it by enabling Row Level Security on every table this endpoint touches and adding policies scoped to auth.uid(). Remove any policy that grants the anon role open SELECT access. Show me the SQL migration and the affected tables.',
      ].join('\n\n'),
    };
  }

  if (variant === 'sequential_id') {
    const steps = [
      'Require authentication on the route and check that the requested record belongs to the caller (ownership check).',
      'Stop exposing auto-increment ids in public URLs — use UUIDs or opaque ids so records cannot be enumerated.',
      'Add rate limiting on the endpoint so bulk enumeration is at least slow and visible.',
    ];
    return {
      title: `${input.path} enumerates records by sequential id without login (IDOR)`,
      impact:
        'Two neighbouring ids returned two different JSON records to a logged-out caller. An attacker can walk the id space and export the whole table.',
      steps,
      fixPrompt: [
        `Security finding (IDOR / broken access control): ${input.path} answers HTTP ${input.actualStatus} with JSON data for id=1 and id=2 to an unauthenticated request, and the bodies differ — records are enumerable.`,
        `Evidence:\n${ev}`,
        'Fix it by requiring an authenticated session on this route, verifying the record belongs to the caller before returning it, and switching to opaque/UUID identifiers. Show me the updated handler and any schema change.',
      ].join('\n\n'),
    };
  }

  const steps = guardSteps(category);
  if (variant === 'exposed') {
    return {
      title: `${label} ${input.path} is reachable without login`,
      impact:
        category === 'debug'
          ? 'Debug and dev endpoints leak configuration, stack traces and internal URLs. They are found by scanners within hours of a deploy.'
          : category === 'api'
            ? 'This endpoint returns data to anyone on the internet. Everything it serves must be treated as public.'
            : 'This surface was open the first time we looked, so it has never been protected.',
      steps,
      fixPrompt: [
        `Security finding: ${label.toLowerCase()} ${input.path} responds HTTP ${input.actualStatus} with real content to an unauthenticated request.`,
        `Evidence:\n${ev}`,
        `Fix it: ${steps.join(' ')} Show me the diff.`,
      ].join('\n\n'),
    };
  }

  return {
    title: `${label} ${input.path} stopped requiring login`,
    impact: `This route used to answer ${input.baselineStatus ?? 'a protected status'} to logged-out visitors and now answers ${input.actualStatus}. A deploy removed or bypassed the auth check.`,
    steps: ['Find the deploy that changed the response — compare middleware/guards between the two versions.', ...steps],
    fixPrompt: [
      `Security regression: ${input.path} previously returned HTTP ${input.baselineStatus ?? '401/403/redirect'} to logged-out visitors and now returns HTTP ${input.actualStatus} with real content.`,
      `Evidence:\n${ev}`,
      `Find the change that removed the authentication check on this route and restore it. ${steps.join(' ')} Show me the diff.`,
    ].join('\n\n'),
  };
}

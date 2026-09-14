import { describe, expect, it } from 'vitest';

import { buildRemediation } from '../lib/runtime/auth-prober/remediation.ts';
import { CATEGORY_LABEL, categorizePath, DEFAULT_PROBER_TARGET_SPECS } from '../lib/runtime/auth-prober/targets.ts';
import { summarizeTargets, verdictForTarget } from '../lib/runtime/auth-prober/summary.ts';
import { describeRunSummary } from '../app/(app)/runtime/probers/prober-view.ts';
import type { ProbeEvidence } from '../lib/runtime/auth-prober/types.ts';

const ev: ProbeEvidence = {
  contentType: 'application/json',
  bodyBytes: 512,
  bodySample: '[{"id":1,"email":"a@b.c"}]',
  bodyHash: 'abcdefabcdefabcd',
  location: null,
  wwwAuthenticate: null,
  bodyKind: 'json_data',
  title: null,
};

describe('auth prober — target categorisation', () => {
  it('categorises every default target and unknown paths by pattern', () => {
    for (const spec of DEFAULT_PROBER_TARGET_SPECS) expect(categorizePath(spec.path)).toBe(spec.category);
    expect(categorizePath('/admin/anything/deep')).toBe('admin');
    expect(categorizePath('/api/v1/orders')).toBe('api');
    expect(categorizePath('/graphql')).toBe('api');
    expect(categorizePath('/__debug__/toolbar')).toBe('debug');
    expect(categorizePath('/actuator/health')).toBe('debug');
    expect(categorizePath('/swagger-ui.html')).toBe('debug');
    expect(categorizePath('/dashboard/reports')).toBe('auth_page');
    expect(categorizePath('/whatever')).toBe('auth_page');
  });

  it('has no duplicate default paths and a label for every category', () => {
    const paths = DEFAULT_PROBER_TARGET_SPECS.map((t) => t.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(Object.keys(CATEGORY_LABEL).sort()).toEqual(['admin', 'api', 'auth_page', 'debug']);
  });
});

describe('auth prober — remediation & AI fix prompt', () => {
  it('regression (variant null) explains before/after and asks to restore the guard', () => {
    const r = buildRemediation({ path: '/admin', variant: null, baselineStatus: 403, actualStatus: 200, evidence: { ...ev, bodyKind: 'html_app', contentType: 'text/html', title: 'Admin' } });
    expect(r.title).toBe('Admin panel /admin stopped requiring login');
    expect(r.steps[0]).toMatch(/deploy/i);
    expect(r.fixPrompt).toContain('previously returned HTTP 403');
    expect(r.fixPrompt).toContain('now returns HTTP 200');
    expect(r.fixPrompt).toContain('Content-Type: text/html');
    expect(r.fixPrompt).toContain('Title: Admin');
  });

  it('exposed API points at auth check + middleware + RLS', () => {
    const r = buildRemediation({ path: '/api/users', variant: 'exposed', actualStatus: 200, evidence: ev });
    expect(r.title).toBe('API endpoint /api/users is reachable without login');
    expect(r.steps.some((s) => /middleware/i.test(s))).toBe(true);
    expect(r.fixPrompt).toContain('/api/users responds HTTP 200');
  });

  it('exposed debug endpoint tells you to remove it from production', () => {
    const r = buildRemediation({ path: '/actuator/env', variant: 'exposed', actualStatus: 200, evidence: { ...ev, bodyKind: 'text' } });
    expect(r.title).toContain('Debug endpoint');
    expect(r.steps[0]).toMatch(/production/i);
  });

  it('anon_role gives RLS SQL steps and includes the key fingerprint', () => {
    const r = buildRemediation({ path: '/api/data', variant: 'anon_role', baselineStatus: 401, actualStatus: 200, keyFingerprint: 'deadbeef00000000', evidence: ev });
    expect(r.steps[0]).toContain('ENABLE ROW LEVEL SECURITY');
    expect(r.fixPrompt).toContain('deadbeef00000000');
    expect(r.fixPrompt).toContain('auth.uid()');
  });

  it('sequential_id explains IDOR and recommends ownership checks and opaque ids', () => {
    const r = buildRemediation({ path: '/api/users/[id]', variant: 'sequential_id', actualStatus: 200, evidence: ev });
    expect(r.title).toContain('IDOR');
    expect(r.steps.join(' ')).toMatch(/UUID|opaque/i);
    expect(r.fixPrompt).toContain('id=1 and id=2');
  });

  it('derives the category from the path when none is stored', () => {
    const r = buildRemediation({ path: '/internal/keys', variant: 'exposed', actualStatus: 200 });
    expect(r.title.startsWith('Admin panel')).toBe(true);
  });
});

describe('auth prober — dashboard summaries', () => {
  it('summarizeTargets counts verdicts, falls back for legacy rows and tracks last probe', () => {
    const t1 = new Date('2026-09-10T00:00:00Z');
    const t2 = new Date('2026-09-12T00:00:00Z');
    const stats = summarizeTargets(
      [
        { baselineStatus: 401, lastActualStatus: 401, lastVerdict: 'protected', lastCheckedAt: t1 },
        { baselineStatus: 200, lastActualStatus: 200, lastVerdict: 'exposed', lastCheckedAt: t2 },
        { baselineStatus: 307, lastActualStatus: 200, lastVerdict: 'inconclusive', lastCheckedAt: t1 },
        { baselineStatus: 403, lastActualStatus: 403, lastVerdict: null }, // legacy → protected
        { baselineStatus: 200, lastActualStatus: 200, lastVerdict: null }, // legacy open baseline → open
        { baselineStatus: null, lastActualStatus: null },
      ],
      2,
    );
    expect(stats).toEqual({ total: 6, protected: 2, open: 2, inconclusive: 1, unbaselined: 1, openFindings: 2, lastCheckedAt: t2 });
  });

  it('verdictForTarget prefers the stored verdict and falls back to status comparison', () => {
    expect(verdictForTarget({ lastVerdict: 'inconclusive', baselineStatus: 401, lastActualStatus: 401 })).toBe('inconclusive');
    expect(verdictForTarget({ lastVerdict: null, baselineStatus: 401, lastActualStatus: 401 })).toBe('protected');
    expect(verdictForTarget({ lastVerdict: null, baselineStatus: 401, lastActualStatus: 500 })).toBe('inconclusive');
    expect(verdictForTarget({ lastVerdict: null, baselineStatus: null, lastActualStatus: null })).toBeNull();
  });

  it('describeRunSummary reads naturally for the common cases', () => {
    expect(describeRunSummary({ checked: 0, baselinesRecorded: 16, newFindings: 0, autoResolved: 0, errors: 0 })).toBe('Recorded 16 baselines.');
    expect(describeRunSummary({ checked: 12, baselinesRecorded: 0, newFindings: 1, autoResolved: 0, errors: 2, inconclusive: 3 })).toBe(
      'Probed 12 targets, 1 new finding, 3 inconclusive, 2 errors.',
    );
    expect(describeRunSummary({ checked: 5, baselinesRecorded: 0, newFindings: 1, autoResolved: 0, errors: 0, suppressedAlerts: 1 })).toContain('1 alert muted (flapping)');
    expect(describeRunSummary({ checked: 0, baselinesRecorded: 0, newFindings: 0, autoResolved: 0, errors: 0 })).toBe('Nothing to probe yet.');
  });
});

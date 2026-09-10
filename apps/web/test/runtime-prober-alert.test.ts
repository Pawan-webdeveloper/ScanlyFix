import { describe, expect, it } from 'vitest';
import { buildProberAlertEmail, summarizeRun } from '../lib/runtime/auth-prober/alert.ts';
import type { ProberRunSummary } from '../lib/runtime/auth-prober/types.ts';

describe('runtime auth prober — alert generation', () => {
  it('builds an email with domain in subject and regression details', () => {
    const email = buildProberAlertEmail({
      projectUrl: 'my-saas.com',
      findings: [
        { path: '/admin', severity: 'critical', baselineStatus: 403, actualStatus: 200 },
        { path: '/dashboard', severity: 'high', baselineStatus: 307, actualStatus: 200 },
      ],
    });

    expect(email.subject).toBe('🚨 Auth regression on my-saas.com — 2 page(s) stopped requiring login');
    expect(email.text).toContain('ScanlyFix Auth Prober detected a security regression on my-saas.com:');
    expect(email.text).toContain('• /admin — previously responded with 403 (protected), now responds with 200 OK without login (critical)');
    expect(email.text).toContain('• /dashboard — previously responded with 307 (protected), now responds with 200 OK without login (high)');
    expect(email.text).toContain('Runtime → Auth Prober');
  });

  it('formats summarizeRun summary string', () => {
    const summary: ProberRunSummary = {
      projectId: 'proj_123',
      ranAt: '2026-09-10T12:00:00.000Z',
      baselinesRecorded: 2,
      checked: 10,
      newFindings: 1,
      autoResolved: 1,
      stillOpen: 0,
      errors: 0,
    };

    expect(summarizeRun(summary)).toBe('baseline:2 checked:10 new:1 resolved:1 open:0 err:0');
  });
});

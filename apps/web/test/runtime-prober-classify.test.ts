import { describe, expect, it } from 'vitest';

import { evaluateTarget, isProtectedStatus, severityForPath } from '../lib/runtime/auth-prober/classify.ts';

describe('auth prober classification', () => {
  it('pehli baar sirf baseline record hota hai — kabhi flag nahi', () => {
    expect(evaluateTarget({ path: '/admin', baseline: null, actual: 200 })).toEqual({
      verdict: 'baseline_recorded',
      status: 200,
    });
  });

  it('protected → open = REGRESSION (feature ka poora point)', () => {
    const v = evaluateTarget({ path: '/admin', baseline: 403, actual: 200 });
    expect(v).toMatchObject({ verdict: 'open', severity: 'critical' });
  });

  it('protected → protected = theek (307→401 bhi still protected)', () => {
    expect(evaluateTarget({ path: '/dashboard', baseline: 307, actual: 401 }).verdict).toBe('protected');
  });

  it('inconclusive: 404/429/5xx kabhi alarm nahi karte', () => {
    expect(evaluateTarget({ path: '/admin', baseline: 401, actual: 404 }).verdict).toBe('inconclusive');
    expect(evaluateTarget({ path: '/admin', baseline: 401, actual: 503 }).verdict).toBe('inconclusive');
  });

  it('redirect statuses protected giné jaate hain', () => {
    for (const s of [301, 302, 303, 307, 308, 401, 403]) expect(isProtectedStatus(s)).toBe(true);
    expect(isProtectedStatus(200)).toBe(false);
  });

  it('severity: admin/api = critical, baaki = high', () => {
    expect(severityForPath('/admin/settings')).toBe('critical');
    expect(severityForPath('/api/users')).toBe('critical');
    expect(severityForPath('/dashboard')).toBe('high');
  });
});
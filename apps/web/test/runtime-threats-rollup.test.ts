import { describe, expect, it } from 'vitest';

import type { AuthPressure } from '@scanlyfix/db';

import {
  CONFIRMED_FAILURE_THRESHOLD,
  UNLABELLED_ATTEMPT_THRESHOLD,
  bruteForceFindings,
} from '../lib/runtime/threats/view.ts';
import { threatMeta, surfaceLabel } from '../lib/runtime/threats/labels.ts';

/**
 * When sign-in volume becomes a finding.
 *
 * The failure mode this guards against is not missing an attack — it is
 * reporting one that is not there. Every site with users has sign-ins all day,
 * and a console that showed them as "threats" would be worthless within a week.
 */

const base = (over: Partial<AuthPressure> = {}): AuthPressure => ({
  sourceIp: '203.0.113.9',
  attempts: 1,
  failures: 0,
  firstSeen: new Date('2026-09-15T10:00:00Z'),
  lastSeen: new Date('2026-09-15T10:04:00Z'),
  pattern: '/api/auth/login',
  ...over,
});

describe('bruteForceFindings', () => {
  it('says nothing about a site whose users are simply signing in', () => {
    const quiet = [
      base({ sourceIp: '203.0.113.1', attempts: 1 }),
      base({ sourceIp: '203.0.113.2', attempts: 4 }),
      base({ sourceIp: '203.0.113.3', attempts: 12 }),
      // One mistyped password is one mistyped password.
      base({ sourceIp: '203.0.113.4', attempts: 3, failures: 2 }),
    ];
    expect(bruteForceFindings(quiet)).toEqual([]);
  });

  it('calls it password guessing only when the application confirmed the failures', () => {
    const [finding] = bruteForceFindings([
      base({ attempts: 40, failures: CONFIRMED_FAILURE_THRESHOLD }),
    ]);
    expect(finding?.confidence).toBe('certain');
    expect(finding?.headline).toMatch(/5 failed sign-ins/);
    expect(finding?.detail).toMatch(/nobody mistypes a password that many times/i);
  });

  it('hedges when it only saw the requests, and says why', () => {
    // Middleware cannot see whether a sign-in succeeded. Twenty attempts from
    // one address could be an attack or a shared office — claiming to know
    // which would be the false accusation this product cannot take back.
    const [finding] = bruteForceFindings([base({ attempts: UNLABELLED_ATTEMPT_THRESHOLD })]);
    expect(finding?.confidence).toBe('likely');
    expect(finding?.headline).toMatch(/20 sign-in attempts/);
    expect(finding?.detail).toMatch(/could be a shared office address/i);
    // And it says exactly how to get certainty.
    expect(finding?.detail).toMatch(/reportAuthFailure/);
  });

  it('holds its fire one attempt below each threshold', () => {
    expect(bruteForceFindings([base({ attempts: UNLABELLED_ATTEMPT_THRESHOLD - 1 })])).toEqual([]);
    expect(
      bruteForceFindings([base({ attempts: 10, failures: CONFIRMED_FAILURE_THRESHOLD - 1 })]),
    ).toEqual([]);
  });

  it('puts what it knows above what it inferred', () => {
    const findings = bruteForceFindings([
      base({ sourceIp: '1.1.1.1', attempts: 900 }),
      base({ sourceIp: '2.2.2.2', attempts: 8, failures: 8 }),
    ]);
    expect(findings.map((f) => f.sourceIp)).toEqual(['2.2.2.2', '1.1.1.1']);
  });

  it('orders the rest by volume', () => {
    const findings = bruteForceFindings([
      base({ sourceIp: '1.1.1.1', attempts: 25 }),
      base({ sourceIp: '2.2.2.2', attempts: 400 }),
      base({ sourceIp: '3.3.3.3', attempts: 90 }),
    ]);
    expect(findings.map((f) => f.sourceIp)).toEqual(['2.2.2.2', '3.3.3.3', '1.1.1.1']);
  });

  it('reports the span in minutes, which is what makes the number alarming', () => {
    const [finding] = bruteForceFindings([
      base({
        attempts: 300,
        failures: 300,
        firstSeen: new Date('2026-09-15T10:00:00Z'),
        lastSeen: new Date('2026-09-15T10:03:00Z'),
      }),
    ]);
    expect(finding?.detail).toMatch(/over 3 minutes/);
  });

  it('never claims a zero-minute span', () => {
    // Every attempt inside one second is the worst case, not a division by zero.
    const at = new Date('2026-09-15T10:00:00Z');
    const [finding] = bruteForceFindings([base({ attempts: 50, firstSeen: at, lastSeen: at })]);
    expect(finding?.detail).toMatch(/over 1 minute\b/);
  });

  it('still reports when the platform gave us no address', () => {
    const [finding] = bruteForceFindings([base({ sourceIp: null, attempts: 60 })]);
    expect(finding?.headline).toMatch(/an address the platform did not report/);
    expect(finding?.sourceIp).toBeNull();
  });

  it('handles an empty window', () => {
    expect(bruteForceFindings([])).toEqual([]);
  });
});

describe('what the console tells the reader', () => {
  it('gives every attack a plain-language meaning and a specific action', () => {
    const kinds = [
      'sql_injection',
      'nosql_injection',
      'xss',
      'path_traversal',
      'command_injection',
      'code_injection',
      'template_injection',
      'ssrf',
      'secret_probe',
      'scanner',
      'brute_force',
    ];
    for (const kind of kinds) {
      const meta = threatMeta(kind);
      expect(meta.label, kind).not.toMatch(/_/);
      expect(meta.meaning.length, kind).toBeGreaterThan(40);
      expect(meta.action.length, kind).toBeGreaterThan(40);
      // "Review your security posture" is not an action.
      expect(meta.action, kind).not.toMatch(/review your (security|posture)/i);
    }
  });

  it('degrades rather than crashing on a kind from a newer detector', () => {
    const meta = threatMeta('some_future_attack');
    expect(meta.label).toBe('Unrecognised attack');
    expect(meta.action).toBeTruthy();
  });

  it('says where the payload was, in words', () => {
    expect(surfaceLabel('query')).toBe('in a query parameter');
    expect(surfaceLabel('user_agent')).toBe('in the user agent');
    expect(surfaceLabel('something_new')).toBe('in the request');
  });
});

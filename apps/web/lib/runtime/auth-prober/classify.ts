// classify.ts — pure decision logic. Network ka kahin role nahi.
import { BODY_KIND_REASON } from './analyze';
import { categorizePath } from './targets';
import type { BodyKind, FindingSeverity, ProbeEvidence, TargetCategory, TargetVerdict } from './types';
export * from './flap';

export function isProtectedStatus(status: number): boolean {
  return status === 401 || status === 403 || (status >= 300 && status < 400);
}

export function isOpenStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Body kinds that make a 2xx *not* an open door. */
const NOT_ACTUALLY_OPEN: ReadonlySet<BodyKind> = new Set(['login_page', 'soft_404', 'spa_shell', 'json_error', 'empty']);

/** Body kinds that count as a 2xx being protected (the server answered, but with a wall). */
const BODY_MEANS_PROTECTED: ReadonlySet<BodyKind> = new Set(['login_page', 'json_error']);

export function severityForCategory(category: TargetCategory): FindingSeverity {
  return category === 'auth_page' ? 'high' : 'critical';
}

export function severityForPath(path: string): FindingSeverity {
  return severityForCategory(categorizePath(path));
}

/**
 * Is this 2xx response genuinely open? Without evidence we have only the
 * status and must trust it (legacy behaviour); with evidence we can rule out
 * the login form, soft-404s and SPA shells.
 */
export function isGenuinelyOpen(status: number, evidence?: ProbeEvidence | null): boolean {
  if (!isOpenStatus(status)) return false;
  if (!evidence) return true;
  return !NOT_ACTUALLY_OPEN.has(evidence.bodyKind);
}

/**
 * Should a first-ever 2xx be reported as an exposure rather than silently
 * accepted as the baseline? Rules are per category, tuned against false alarms:
 *
 *   api        — only when the body is JSON that carries data.
 *   debug      — any real content (HTML app page, JSON data or text) — these should not exist in prod at all.
 *   admin      — real HTML page or JSON data (login form / shell / 404 already excluded).
 *   auth_page  — never at baseline: /dashboard being a public marketing page is common and legitimate.
 */
export function isExposedAtBaseline(category: TargetCategory, evidence: ProbeEvidence): boolean {
  const kind = evidence.bodyKind;
  switch (category) {
    case 'api':
      return kind === 'json_data';
    case 'debug':
      return kind === 'json_data' || kind === 'html_app' || kind === 'text';
    case 'admin':
      return kind === 'json_data' || kind === 'html_app';
    case 'auth_page':
      return false;
  }
}

function reasonFor(evidence: ProbeEvidence | null | undefined, fallback: string): string {
  return evidence ? BODY_KIND_REASON[evidence.bodyKind] : fallback;
}

/**
 * Pure decision function — path + baseline + actual (+ evidence) → verdict.
 */
export function evaluateTarget(params: {
  path: string;
  baseline: number | null;
  actual: number;
  anonActual?: number | null;
  evidence?: ProbeEvidence | null;
  anonEvidence?: ProbeEvidence | null;
}): TargetVerdict {
  const { path, baseline, actual, anonActual, evidence, anonEvidence } = params;
  const category = categorizePath(path);
  const severity = severityForCategory(category);

  if (baseline === null) {
    if (evidence && isOpenStatus(actual) && isExposedAtBaseline(category, evidence)) {
      return { verdict: 'exposed', status: actual, severity, reason: reasonFor(evidence, 'Open on first probe.') };
    }
    return { verdict: 'baseline_recorded', status: actual };
  }

  const baselineWasProtected = isProtectedStatus(baseline);
  const actualIsOpen = isOpenStatus(actual);
  const actualIsProtected = isProtectedStatus(actual) || (actualIsOpen && !!evidence && BODY_MEANS_PROTECTED.has(evidence.bodyKind));

  if (actualIsOpen && !isGenuinelyOpen(actual, evidence) && !actualIsProtected) {
    // 2xx but soft-404 / SPA shell / empty — cannot judge either way.
    return { verdict: 'inconclusive', status: actual, reason: reasonFor(evidence, 'Cannot judge response.') };
  }

  if (baselineWasProtected && actualIsOpen && !actualIsProtected) {
    return { verdict: 'open', status: actual, severity, reason: reasonFor(evidence, 'Responds 2xx without login.') };
  }

  if (actualIsProtected) {
    if (anonActual !== undefined && anonActual !== null && isGenuinelyOpen(anonActual, anonEvidence)) {
      return { verdict: 'anon_open', status: actual, anonStatus: anonActual, severity };
    }
    return { verdict: 'protected', status: actual, reason: evidence ? BODY_KIND_REASON[evidence.bodyKind] : undefined };
  }

  if (actualIsOpen) {
    return { verdict: 'open', status: actual, severity, reason: reasonFor(evidence, 'Responds 2xx without login.') };
  }
  return { verdict: 'inconclusive', status: actual, reason: `HTTP ${actual} — not an auth signal (404/429/5xx).` };
}

/**
 * Sequential-ID (IDOR) rule: the same route answers 2xx JSON data for two
 * neighbouring ids with *different* bodies → records are enumerable without login.
 */
export function isSequentialIdExposure(first: ProbeEvidence | null | undefined, second: ProbeEvidence | null | undefined): boolean {
  if (!first || !second) return false;
  if (first.bodyKind !== 'json_data' || second.bodyKind !== 'json_data') return false;
  return first.bodyHash !== second.bodyHash;
}

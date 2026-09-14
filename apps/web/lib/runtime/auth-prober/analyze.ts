import { createHash } from 'node:crypto';

import { PROBE_BODY_SAMPLE_CHARS, type BodyKind, type ProbeEvidence } from './types';

/**
 * Pure response analysis. This is what separates "the status was 200" from
 * "the page is actually open": an app shell, a soft-404 and a login form all
 * answer 200, and none of them is an auth bypass.
 */

const LOGIN_TITLE = /\b(sign\s?in|log\s?in|login|authenticate|welcome back)\b/i;
const LOGIN_FORM = /<input[^>]+type=["']?password["']?/i;
const LOGIN_ACTION = /<form[^>]+action=["'][^"']*(login|signin|sign-in|auth)[^"']*["']/i;
const LOGIN_TEXT = /\b(forgot (your )?password|continue with (google|github|email)|sign in to continue)\b/i;

const SOFT_404_TITLE = /\b(404|not found|page (doesn'?t|does not|could not be) (exist|found)|no such page)\b/i;
const SOFT_404_BODY = /\b(404|page not found|this page (doesn'?t|does not|could not be) (exist|be found|found))\b/i;

const ERROR_JSON_KEYS = new Set(['error', 'errors', 'message', 'statuscode', 'status', 'code', 'detail']);

export function hashBody(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Strip tags, collapse whitespace — for a readable evidence snippet and stable hashing. */
export function normalizeBody(text: string): string {
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m?.[1]) return null;
  const t = m[1].replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t.slice(0, 120) : null;
}

export function isHtml(contentType: string | null, body: string): boolean {
  if (contentType && /text\/html|application\/xhtml/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html)/i.test(body);
}

export function isJson(contentType: string | null, body: string): boolean {
  if (contentType && /application\/(.*\+)?json/i.test(contentType)) return true;
  const t = body.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

export function looksLikeLoginPage(html: string): boolean {
  if (LOGIN_FORM.test(html)) return true;
  if (LOGIN_ACTION.test(html)) return true;
  const title = extractTitle(html) ?? '';
  return LOGIN_TITLE.test(title) && LOGIN_TEXT.test(html);
}

export function looksLikeSoftNotFound(html: string): boolean {
  const title = extractTitle(html) ?? '';
  if (SOFT_404_TITLE.test(title)) return true;
  const text = normalizeBody(html);
  // Short pages that literally say "not found" — long pages mentioning 404 in passing do not count.
  return text.length < 1500 && SOFT_404_BODY.test(text);
}

/** JSON that carries data, as opposed to `{ "error": "unauthorized" }`. */
export function classifyJson(body: string): 'json_data' | 'json_error' {
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return 'json_data';
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed as Record<string, unknown>);
      if (keys.length === 0) return 'json_error';
      const allErrorish = keys.every((k) => ERROR_JSON_KEYS.has(k.toLowerCase()));
      return allErrorish ? 'json_error' : 'json_data';
    }
    return 'json_error';
  } catch {
    return 'json_error';
  }
}

export function classifyBody(input: {
  status: number;
  contentType: string | null;
  body: string;
  /** Hash of the homepage body — a target with the same hash is the SPA shell. */
  homeBodyHash?: string | null;
}): BodyKind {
  const { status, contentType, body } = input;
  if (status >= 300 && status < 400) return 'redirect';
  if (body.trim().length === 0) return 'empty';

  if (isJson(contentType, body)) return classifyJson(body);

  if (isHtml(contentType, body)) {
    if (looksLikeLoginPage(body)) return 'login_page';
    if (looksLikeSoftNotFound(body)) return 'soft_404';
    if (input.homeBodyHash && hashBody(normalizeBody(body)) === input.homeBodyHash) return 'spa_shell';
    return 'html_app';
  }

  return 'text';
}

/** Build the evidence record stored on a finding. Never stores the whole body. */
export function buildEvidence(input: {
  status: number;
  contentType: string | null;
  body: string;
  bodyBytes: number;
  location: string | null;
  wwwAuthenticate: string | null;
  homeBodyHash?: string | null;
}): ProbeEvidence {
  const normalized = normalizeBody(input.body);
  return {
    contentType: input.contentType,
    bodyBytes: input.bodyBytes,
    bodySample: normalized.slice(0, PROBE_BODY_SAMPLE_CHARS),
    bodyHash: hashBody(normalized),
    location: input.location,
    wwwAuthenticate: input.wwwAuthenticate,
    bodyKind: classifyBody(input),
    title: isHtml(input.contentType, input.body) ? extractTitle(input.body) : null,
  };
}

/** Plain-language reason for a body kind — shown in the targets table and in emails. */
export const BODY_KIND_REASON: Readonly<Record<BodyKind, string>> = {
  login_page: 'Responded 200 but the body is the sign-in form — still behind login.',
  soft_404: 'Responded 200 but the page says "not found" — nothing is served here.',
  spa_shell: 'Responded 200 with the same app shell as the homepage — routing happens client-side, cannot judge.',
  json_data: 'Returned JSON containing data.',
  json_error: 'Returned JSON shaped like an error object — treated as protected.',
  html_app: 'Returned real page content.',
  text: 'Returned a non-HTML body.',
  empty: 'Returned an empty body.',
  redirect: 'Redirected (typically to a login page).',
};

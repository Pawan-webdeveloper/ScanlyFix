import { describe, expect, it } from 'vitest';

import {
  BODY_KIND_REASON,
  buildEvidence,
  classifyBody,
  classifyJson,
  extractTitle,
  hashBody,
  looksLikeLoginPage,
  looksLikeSoftNotFound,
  normalizeBody,
} from '../lib/runtime/auth-prober/analyze.ts';

const LOGIN_HTML = `<!doctype html><html><head><title>Sign in — Acme</title></head><body>
<form action="/api/auth/callback/credentials" method="post">
<input name="email" type="email"><input name="password" type="password"><button>Sign in</button></form>
<a href="/forgot">Forgot your password?</a></body></html>`;

const SOFT_404_HTML = `<!doctype html><html><head><title>404: This page could not be found</title></head><body><h1>404</h1><p>This page could not be found.</p></body></html>`;

const ADMIN_HTML = `<!doctype html><html><head><title>Admin · Users</title></head><body><nav>Users Billing Settings</nav><table><tr><td>alice@acme.com</td><td>owner</td></tr></table></body></html>`;

const SHELL_HTML = `<!doctype html><html><head><title>Acme</title></head><body><div id="root"></div><script src="/static/app.js"></script></body></html>`;

describe('auth prober — response analysis', () => {
  it('recognises the sign-in form as a login page (password input / auth action / title+text)', () => {
    expect(looksLikeLoginPage(LOGIN_HTML)).toBe(true);
    expect(looksLikeLoginPage('<html><form action="/login"><input name="u"></form></html>')).toBe(true);
    expect(
      looksLikeLoginPage('<html><head><title>Log in</title></head><body><button>Continue with Google</button></body></html>'),
    ).toBe(true);
    expect(looksLikeLoginPage(ADMIN_HTML)).toBe(false);
  });

  it('recognises a soft-404 (200 with "not found") by title or short body', () => {
    expect(looksLikeSoftNotFound(SOFT_404_HTML)).toBe(true);
    expect(looksLikeSoftNotFound('<html><body><p>Page not found</p></body></html>')).toBe(true);
    // Long real pages that mention 404 in passing are not soft-404s.
    const longPage = `<html><head><title>Docs</title></head><body>${'Lorem ipsum dolor sit amet. '.repeat(80)} Our API returns 404 when missing.</body></html>`;
    expect(looksLikeSoftNotFound(longPage)).toBe(false);
    expect(looksLikeSoftNotFound(ADMIN_HTML)).toBe(false);
  });

  it('classifies JSON as data vs error-shaped', () => {
    expect(classifyJson('[{"id":1}]')).toBe('json_data');
    expect(classifyJson('{"users":[],"total":0}')).toBe('json_data');
    expect(classifyJson('{"error":"unauthorized"}')).toBe('json_error');
    expect(classifyJson('{"message":"Forbidden","statusCode":403}')).toBe('json_error');
    expect(classifyJson('{}')).toBe('json_error');
    expect(classifyJson('not json')).toBe('json_error');
  });

  it('classifyBody: redirect / empty / login / soft-404 / shell / app / json / text', () => {
    expect(classifyBody({ status: 307, contentType: 'text/html', body: '' })).toBe('redirect');
    expect(classifyBody({ status: 200, contentType: 'text/html', body: '   ' })).toBe('empty');
    expect(classifyBody({ status: 200, contentType: 'text/html; charset=utf-8', body: LOGIN_HTML })).toBe('login_page');
    expect(classifyBody({ status: 200, contentType: 'text/html', body: SOFT_404_HTML })).toBe('soft_404');
    expect(classifyBody({ status: 200, contentType: 'text/html', body: ADMIN_HTML })).toBe('html_app');
    expect(classifyBody({ status: 200, contentType: 'application/json', body: '[{"id":1}]' })).toBe('json_data');
    expect(classifyBody({ status: 200, contentType: null, body: '{"error":"nope"}' })).toBe('json_error');
    expect(classifyBody({ status: 200, contentType: 'text/plain', body: 'DATABASE_URL=postgres://...' })).toBe('text');
  });

  it('classifyBody: a body identical to the homepage is the SPA shell', () => {
    const homeHash = hashBody(normalizeBody(SHELL_HTML));
    expect(classifyBody({ status: 200, contentType: 'text/html', body: SHELL_HTML, homeBodyHash: homeHash })).toBe('spa_shell');
    // Same page without the home hash cannot be told apart → html_app (status-only fallback)
    expect(classifyBody({ status: 200, contentType: 'text/html', body: SHELL_HTML })).toBe('html_app');
    // A different page with the hash present is still html_app
    expect(classifyBody({ status: 200, contentType: 'text/html', body: ADMIN_HTML, homeBodyHash: homeHash })).toBe('html_app');
  });

  it('buildEvidence never stores the whole body and strips tags from the sample', () => {
    const body = ADMIN_HTML + '<p>' + 'x'.repeat(5000) + '</p>';
    const ev = buildEvidence({
      status: 200,
      contentType: 'text/html',
      body,
      bodyBytes: body.length,
      location: null,
      wwwAuthenticate: null,
    });
    expect(ev.bodySample.length).toBeLessThanOrEqual(240);
    expect(ev.bodySample).not.toContain('<');
    expect(ev.bodySample).toContain('Users Billing Settings');
    expect(ev.title).toBe('Admin · Users');
    expect(ev.bodyKind).toBe('html_app');
    expect(ev.bodyHash).toHaveLength(16);
    expect(ev.bodyBytes).toBe(body.length);
  });

  it('extractTitle handles whitespace and missing titles', () => {
    expect(extractTitle('<title>\n  Hello\n  World </title>')).toBe('Hello World');
    expect(extractTitle('<html></html>')).toBeNull();
  });

  it('has a reason string for every body kind', () => {
    for (const kind of ['login_page', 'soft_404', 'spa_shell', 'json_data', 'json_error', 'html_app', 'text', 'empty', 'redirect'] as const) {
      expect(BODY_KIND_REASON[kind].length).toBeGreaterThan(10);
    }
  });
});

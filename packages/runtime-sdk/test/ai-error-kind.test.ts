import { describe, expect, it } from 'vitest';

import { AI_ERROR_KINDS, classifyAiError, extractStatus } from '../src/ai/error-kind.ts';
import { SpendCeilingError } from '../src/ai/spend-firewall.ts';

/** The shape the OpenAI and Anthropic SDKs actually throw. */
function apiError(status: number, message = 'request failed'): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe('classifyAiError — status codes', () => {
  it('maps the statuses a developer needs to tell apart', () => {
    expect(classifyAiError(apiError(429))).toBe('rate_limit');
    expect(classifyAiError(apiError(401))).toBe('auth');
    expect(classifyAiError(apiError(403))).toBe('auth');
    expect(classifyAiError(apiError(400))).toBe('bad_request');
    expect(classifyAiError(apiError(404))).toBe('bad_request');
    expect(classifyAiError(apiError(422))).toBe('bad_request');
    expect(classifyAiError(apiError(408))).toBe('timeout');
    expect(classifyAiError(apiError(500))).toBe('server_error');
    expect(classifyAiError(apiError(529))).toBe('server_error');
  });

  it('reads a status off every shape the SDKs use', () => {
    expect(extractStatus(apiError(429))).toBe(429);
    expect(extractStatus({ statusCode: 500 })).toBe(500);
    expect(extractStatus({ response: { status: 401 } })).toBe(401);
    expect(extractStatus({ status: '429' })).toBe(429);
    expect(extractStatus({ status: 'nonsense' })).toBeNull();
    expect(extractStatus(null)).toBeNull();
    expect(extractStatus('a string')).toBeNull();
  });
});

describe('classifyAiError — our own refusal', () => {
  it('labels a firewall refusal distinctly, because it means the guard worked', () => {
    const err = new SpendCeilingError(10_000_000, 500_000, 10_500_000);
    expect(classifyAiError(err)).toBe('ceiling');
  });

  it('recognises the refusal by name, so a structurally-cloned error still classifies', () => {
    expect(classifyAiError({ name: 'SpendCeilingError', message: 'ceiling hit' })).toBe('ceiling');
  });
});

describe('classifyAiError — transport failures', () => {
  it('separates a timeout from a network failure', () => {
    expect(classifyAiError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyAiError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyAiError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timeout');
    expect(classifyAiError(Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe('timeout');

    expect(classifyAiError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('network');
    expect(classifyAiError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('network');
    expect(classifyAiError(Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }))).toBe('network');
  });

  it('unwraps one level of cause, which is where undici hides the real failure', () => {
    expect(classifyAiError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe('network');
    expect(classifyAiError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))).toBe('timeout');
    expect(classifyAiError(Object.assign(new TypeError('fetch failed'), { cause: { name: 'AbortError' } }))).toBe('timeout');
  });

  it('recognises a bare fetch failure', () => {
    expect(classifyAiError(new TypeError('fetch failed'))).toBe('network');
  });

  it('prefers the status when both a status and a code are present', () => {
    expect(classifyAiError(Object.assign(new Error('x'), { status: 429, code: 'ECONNRESET' }))).toBe('rate_limit');
  });
});

describe('classifyAiError — safety', () => {
  it('never throws, whatever it is handed', () => {
    for (const value of [null, undefined, 'string', 42, [], {}, new Error('plain'), Symbol('s')]) {
      expect(() => classifyAiError(value)).not.toThrow();
    }
    expect(classifyAiError(null)).toBe('unknown');
    expect(classifyAiError(new Error('plain'))).toBe('unknown');
  });

  it('survives a self-referential cause chain', () => {
    const err: Record<string, unknown> = { name: 'Error' };
    err.cause = err;
    expect(classifyAiError(err)).toBe('unknown');
  });

  it('only ever returns a member of the closed set', () => {
    const inputs: unknown[] = [
      apiError(429),
      apiError(418),
      new SpendCeilingError(1, 1, 2),
      Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
      new TypeError('fetch failed'),
      null,
      'nope',
    ];
    for (const input of inputs) {
      expect(AI_ERROR_KINDS).toContain(classifyAiError(input));
    }
  });

  it('never returns anything derived from the error message', () => {
    // Provider validation errors echo request content back, which can include
    // fragments of the prompt. The label must not depend on that text.
    const leaky = apiError(400, 'Invalid content: "the user password is hunter2"');
    const kind = classifyAiError(leaky);
    expect(kind).toBe('bad_request');
    expect(JSON.stringify(kind)).not.toContain('hunter2');
  });
});

/**
 * Classifying a failed AI call without ever recording why it says it failed.
 *
 * A provider error message is not safe telemetry. OpenAI and Anthropic both
 * echo request content back in validation errors — an invalid role, an
 * oversized message, a malformed tool call — so `error.message` can contain
 * fragments of the prompt. The same is true of `error.response.data`. This
 * module therefore reads only the SHAPE of the error (a status code, an error
 * name, a syscall) and maps it to one of a closed set of labels.
 *
 * Nothing else about the error is returned, and the caller has nothing else to
 * send.
 */

export const AI_ERROR_KINDS = [
  /** Our own firewall refused the call before it reached the provider. */
  'ceiling',
  /** 429 — provider rate limit or quota. */
  'rate_limit',
  /** 401/403 — bad or missing API key, or an org permission problem. */
  'auth',
  /** 400/404/422 — the request itself was rejected. */
  'bad_request',
  /** 408, aborts, and socket timeouts. */
  'timeout',
  /** 5xx from the provider. */
  'server_error',
  /** DNS, connection refused, TLS — never reached the provider. */
  'network',
  /** Anything that matches none of the above. */
  'unknown',
] as const;

export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/** Network-level failures surface as a syscall/code rather than a status. */
const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return null;
}

/** Pulls an HTTP status off the shapes the provider SDKs actually throw. */
export function extractStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;

  const direct = readNumber(e, 'status') ?? readNumber(e, 'statusCode');
  if (direct !== null) return direct;

  const response = e.response;
  if (response && typeof response === 'object') {
    const fromResponse = readNumber(response as Record<string, unknown>, 'status');
    if (fromResponse !== null) return fromResponse;
  }
  return null;
}

function statusToKind(status: number): AiErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/**
 * Maps a thrown value to a label. Never throws, and never reads the message
 * except to recognise an abort — see the note at the top of the file.
 */
export function classifyAiError(error: unknown): AiErrorKind {
  if (!error || typeof error !== 'object') return 'unknown';
  const e = error as Record<string, unknown>;

  // Our own refusal is the most useful label of all: the firewall worked.
  if (e.name === 'SpendCeilingError') return 'ceiling';

  const status = extractStatus(error);
  if (status !== null) return statusToKind(status);

  // AbortController and provider SDK timeouts both surface as a name, not a status.
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'timeout';

  const code = typeof e.code === 'string' ? e.code : null;
  if (code) {
    if (TIMEOUT_CODES.has(code)) return 'timeout';
    if (NETWORK_CODES.has(code)) return 'network';
  }

  // Undici wraps the real failure; one level down is enough.
  const cause = e.cause;
  if (cause && typeof cause === 'object' && cause !== error) {
    const causeCode = typeof (cause as Record<string, unknown>).code === 'string' ? ((cause as Record<string, unknown>).code as string) : null;
    if (causeCode) {
      if (TIMEOUT_CODES.has(causeCode)) return 'timeout';
      if (NETWORK_CODES.has(causeCode)) return 'network';
    }
    if ((cause as Record<string, unknown>).name === 'AbortError') return 'timeout';
  }

  if (e.name === 'TypeError' && typeof e.message === 'string' && /fetch failed/i.test(e.message)) return 'network';

  return 'unknown';
}

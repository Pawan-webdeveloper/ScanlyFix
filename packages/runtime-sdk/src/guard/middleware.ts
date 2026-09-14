import { NextResponse } from 'next/server';
import { createRuntime, type RuntimeClient } from '../runtime.ts';
import { detectThreats } from '../threat/detect.ts';
import {
  buildAuthAttemptEvent,
  buildAuthFailureEvent,
  buildThreatEvents,
  clientIpFrom,
} from '../threat/report.ts';
import { buildRouteEvent } from './observe.ts';
import { classifyOutcome, type ResponseLike, type RouteOutcome } from './outcome.ts';
import type { SessionDetectionOptions } from './session.ts';

/** Static assets / internals — excluded from route monitoring */
const DEFAULT_EXCLUDED: ReadonlyArray<RegExp> = [
  /^\/_next\//,
  /^\/_vercel\//,
  /^\/api\/inngest/,
  /\.(js|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|otf|webp|avif|txt|xml|json)$/i,
];

export type WaitUntilExecutor = (promise: Promise<unknown>) => void;

export type GuardOptions = SessionDetectionOptions & {
  /** Optional custom runtime client */
  runtime?: RuntimeClient;
  /**
   * Watch for attacks — SQL injection, XSS, traversal, config probing, sign-in
   * flooding. On by default: the detector is bounded and side-effect free, and a
   * security feature nobody switched on protects nobody.
   */
  threats?: boolean;
  /**
   * Optional custom waitUntil executor (e.g. from Cloudflare ctx.waitUntil or a custom background runner).
   * If omitted, withGuard checks event.waitUntil, attempts to load from '@vercel/functions',
   * and falls back to void runtime.flush() on self-hosted Node.js.
   */
  waitUntil?: WaitUntilExecutor;
  /** Extra skip rule (e.g. health endpoints) */
  exclude?: (pathname: string) => boolean;
  /** Prefix skips */
  excludePrefixes?: ReadonlyArray<string>;
};

export interface NextRequestLike {
  /**
   * `search` is where most attack payloads actually live, so it is read when the
   * platform provides it. Optional so that an older caller passing only
   * `pathname` still type-checks and still gets path-based detection.
   */
  nextUrl: { pathname: string; hostname?: string; search?: string };
  method: string;
  headers: {
    get: (name: string) => string | null;
    has: (name: string) => boolean;
  };
}

export interface NextFetchEventLike {
  waitUntil?: (promise: Promise<unknown>) => void;
}

let vercelWaitUntilChecked = false;
let vercelWaitUntilFn: WaitUntilExecutor | null = null;

/**
 * Resolves the appropriate waitUntil executor across Vercel, Cloudflare, and self-hosted Node.
 * Never throws.
 */
export async function resolveWaitUntil(
  optionsWaitUntil?: WaitUntilExecutor,
  eventWaitUntil?: WaitUntilExecutor,
): Promise<WaitUntilExecutor | null> {
  // 1. Explicit option passed to withGuard (e.g. Cloudflare ctx.waitUntil)
  if (typeof optionsWaitUntil === 'function') {
    return optionsWaitUntil;
  }

  // 2. event.waitUntil from NextFetchEvent or Cloudflare execution context
  if (typeof eventWaitUntil === 'function') {
    return eventWaitUntil;
  }

  // 3. Attempt dynamic import from '@vercel/functions' if available
  if (!vercelWaitUntilChecked) {
    vercelWaitUntilChecked = true;
    try {
      const pkg = '@vercel/functions';
      const vercelMod = await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg);
      if (typeof vercelMod?.waitUntil === 'function') {
        vercelWaitUntilFn = vercelMod.waitUntil;
      }
    } catch {
      // Not in a Vercel environment or @vercel/functions not installed (e.g. self-hosted Node)
      vercelWaitUntilFn = null;
    }
  }

  return vercelWaitUntilFn;
}

export function resetWaitUntilCacheForTests(): void {
  vercelWaitUntilChecked = false;
  vercelWaitUntilFn = null;
}

let shared: RuntimeClient | null = null;

function getSharedRuntime(): RuntimeClient {
  shared ??= createRuntime({
    projectId: process.env.RUNTIME_PROJECT_ID ?? '',
    host: process.env.RUNTIME_HOST ?? '',
    signingSecret: process.env.RUNTIME_SIGNING_SECRET ?? '',
    ingestUrl: process.env.RUNTIME_INGEST_URL ?? '',
    maxBatchSize: 10,
    flushIntervalMs: 5_000,
    onError: () => {},
  });
  return shared;
}

function isOwnIngestPath(ingestUrl: string, pathname: string): boolean {
  try {
    return new URL(ingestUrl).pathname === pathname;
  } catch {
    return false;
  }
}

/**
 * Paths where looking for attacks is pointless, which is a far shorter list than
 * the one for route observation.
 *
 * Reusing `isExcluded` here would have been the obvious mistake: it skips
 * anything ending in `.json`, `.xml` or `.txt`, and a request for
 * `/credentials.json` or `/.env.txt` is precisely what this feature exists to
 * catch. Only our own traffic and the framework's internals are skipped.
 */
function isThreatExcluded(pathname: string, ingestUrl: string): boolean {
  return (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/_vercel/') ||
    pathname.startsWith('/api/runtime/ingest') ||
    isOwnIngestPath(ingestUrl, pathname)
  );
}

/** Pure: is this path outside what Guard observes? */
function isExcluded(pathname: string, ingestUrl: string, options: GuardOptions): boolean {
  return (
    pathname === '/' ||
    pathname.startsWith('/api/runtime/ingest') ||
    DEFAULT_EXCLUDED.some((re) => re.test(pathname)) ||
    options.excludePrefixes?.some((p) => pathname.startsWith(p)) === true ||
    options.exclude?.(pathname) === true ||
    isOwnIngestPath(ingestUrl, pathname)
  );
}

/**
 * Middleware wrapper for observing routes and server actions in Next.js applications:
 *
 *   export default withGuard();
 *
 * Or wrap existing middleware, which is the configuration worth having — Guard
 * then also records what that middleware DID with each request, turning "a
 * logged-out request arrived" into "a logged-out request was turned away" (or
 * was not):
 *
 *   export default withGuard(myAuthMiddleware);
 */
export function withGuard<TReq extends NextRequestLike = NextRequestLike, TRes = Response, TEvent = unknown>(
  userMiddleware?: (req: TReq, event?: TEvent) => Promise<TRes> | TRes,
  options: GuardOptions = {},
): (req: TReq, event?: TEvent) => Promise<TRes> {
  const hasUserMiddleware = typeof userMiddleware === 'function';

  return async function guarded(req: TReq, event?: TEvent): Promise<TRes> {
    // ── Phase 1: decide whether to observe at all (cheap, cannot throw) ──────
    let runtime: RuntimeClient | null = null;
    let observe = false;
    let watchThreats = false;
    try {
      runtime = options.runtime ?? getSharedRuntime();
      observe = !isExcluded(req.nextUrl.pathname, runtime.config.ingestUrl, options);
      watchThreats =
        options.threats !== false && !isThreatExcluded(req.nextUrl.pathname, runtime.config.ingestUrl);
    } catch {
      observe = false; // Guard never causes user requests to fail
      watchThreats = false;
    }

    // ── Phase 2: run the application's middleware ────────────────────────────
    // Its result is returned untouched, and an error it throws propagates
    // unchanged — the observation is recorded either way.
    let response: TRes;
    try {
      response = hasUserMiddleware
        ? await userMiddleware(req, event)
        : (NextResponse.next() as unknown as TRes);
    } catch (middlewareError) {
      if (runtime) {
        // The request crashed; that says nothing about authentication — but a
        // payload that crashes the middleware is MORE interesting, not less.
        if (observe) queueObservation(runtime, req, options, 'unknown', undefined);
        if (watchThreats) queueThreats(runtime, req, undefined, undefined);
        if (observe || watchThreats) scheduleDelivery(runtime, req, options, event);
      }
      throw middlewareError;
    }

    // ── Phase 3: classify what happened, then report in the background ───────
    if (observe && runtime) {
      let outcome: RouteOutcome = 'unknown';
      let status: number | undefined;
      try {
        const responseLike = response as unknown as ResponseLike | null;
        outcome = classifyOutcome(responseLike, { hasUserMiddleware });
        if (hasUserMiddleware && typeof responseLike?.status === 'number') {
          status = responseLike.status;
        }
      } catch {
        outcome = 'unknown';
      }
      queueObservation(runtime, req, options, outcome, status);
      if (watchThreats) queueThreats(runtime, req, outcome === 'blocked', status);
    } else if (watchThreats && runtime) {
      queueThreats(runtime, req, undefined, undefined);
    }

    if (runtime && (observe || watchThreats)) scheduleDelivery(runtime, req, options, event);

    return response;
  };
}

/**
 * Builds the route observation and queues it. Every failure mode is swallowed:
 * telemetry must never change what the application returns.
 */
function queueObservation(
  runtime: RuntimeClient,
  req: NextRequestLike,
  options: GuardOptions,
  outcome: RouteOutcome,
  status: number | undefined,
): void {
  try {
    const routeEvent = buildRouteEvent(
      {
        pathname: req.nextUrl.pathname,
        method: req.method,
        cookieHeader: req.headers.get('cookie'),
        isServerAction: req.headers.has('next-action'),
      },
      { ...options, outcome, status },
    );
    if (routeEvent) runtime.report(routeEvent);
  } catch {
    // Guard never causes user requests to fail
  }
}

/**
 * Inspects the request for attacks and queues whatever was found.
 *
 * Reads the path, the query string, the user agent and a short allowlist of
 * headers — never the cookie, never a body. A request can produce several
 * events when it carries several distinct attack classes, and none at all in
 * the overwhelmingly common case where it is just a person using the site.
 */
function queueThreats(
  runtime: RuntimeClient,
  req: NextRequestLike,
  blocked: boolean | undefined,
  status: number | undefined,
): void {
  try {
    const headerOf = (name: string): string | null => req.headers.get(name);
    const userAgent = req.headers.get('user-agent');
    const sourceIp = clientIpFrom(headerOf);

    const ctx = {
      pathname: req.nextUrl.pathname,
      method: req.method,
      userAgent,
      sourceIp,
      blocked,
      status: status ?? null,
    };

    const matches = detectThreats({
      pathname: req.nextUrl.pathname,
      search: req.nextUrl.search ?? null,
      userAgent,
      header: headerOf,
    });
    if (matches.length > 0) {
      for (const threatEvent of buildThreatEvents(matches, ctx)) runtime.report(threatEvent);
    }

    const authEvent = buildAuthAttemptEvent(ctx);
    if (authEvent) runtime.report(authEvent);
  } catch {
    // Guard never causes user requests to fail
  }
}

/**
 * Sends whatever is queued, once per request rather than once per reporter.
 *
 * The flush is handed to the platform's `waitUntil` where one exists so the
 * response is not held open waiting for our ingest.
 */
function scheduleDelivery(
  runtime: RuntimeClient,
  req: NextRequestLike,
  options: GuardOptions,
  event: unknown,
): void {
  try {
    // Auto-detect host from request so ScanlyFix automatically matches the project
    const reqHost =
      process.env.RUNTIME_HOST ??
      req.headers.get('x-forwarded-host') ??
      req.headers.get('host') ??
      req.nextUrl?.hostname;

    const flushPromise = runtime.flush(reqHost ?? undefined);
    // Never let an unhandled rejection escape into the request lifecycle.
    void flushPromise.catch(() => {});

    const eventWaitUntil = (event as NextFetchEventLike | undefined)?.waitUntil;
    void resolveWaitUntil(options.waitUntil, eventWaitUntil)
      .then((executor) => {
        if (executor) executor(flushPromise);
      })
      .catch(() => {
        // Executor lookup failed — the flush is already in flight regardless.
      });
  } catch {
    // Guard never causes user requests to fail
  }
}

/**
 * Report a sign-in that you know failed.
 *
 * Middleware runs before your login handler and cannot see whether the password
 * was right, so on its own this feature can only count attempts. One call from
 * inside the handler turns that into certainty:
 *
 *   export async function POST(req: Request) {
 *     const user = await verify(await req.json());
 *     if (!user) {
 *       reportAuthFailure(req);
 *       return new Response('Invalid credentials', { status: 401 });
 *     }
 *     ...
 *   }
 *
 * Takes anything with `headers.get` and a URL — a plain `Request` works. Never
 * throws, never blocks, and never reads the body: the credentials that failed
 * are the application's business, not ours.
 */
export function reportAuthFailure(
  req: { headers: { get: (name: string) => string | null }; url?: string; method?: string },
  options: GuardOptions = {},
): void {
  try {
    const runtime = options.runtime ?? getSharedRuntime();
    let pathname = '/';
    try {
      if (req.url) pathname = new URL(req.url, 'http://local.invalid').pathname;
    } catch {
      pathname = '/';
    }

    const headerOf = (name: string): string | null => req.headers.get(name);
    runtime.report(
      buildAuthFailureEvent({
        pathname,
        method: req.method ?? 'POST',
        userAgent: headerOf('user-agent'),
        sourceIp: clientIpFrom(headerOf),
      }),
    );

    const reqHost = process.env.RUNTIME_HOST ?? headerOf('x-forwarded-host') ?? headerOf('host');
    void runtime.flush(reqHost ?? undefined).catch(() => {});
  } catch {
    // Reporting a failed login must never turn into a failed login page.
  }
}

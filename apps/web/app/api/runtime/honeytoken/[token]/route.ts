import { NextResponse } from 'next/server';

import { countRecentHoneytokenHits, findCanaryByHoneytoken, insertCanaryEvents } from '@scanlyfix/db';

import { EVENTS, inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * How long one canary's hits collapse into a single recorded event.
 *
 * Every hit is evidence, but the hundredth hit in a minute is not new evidence —
 * and this endpoint is unauthenticated by design, so anyone who works out the
 * URL shape can call it in a loop. Without a bound, that loop writes a row to
 * our own events table per request: an anonymous caller choosing how much
 * storage we spend, and burying the real timeline under their noise.
 */
const RECORD_WINDOW_MINUTES = 5;

/** At most one email per canary per hour, however many times the URL is called. */
const ALERT_WINDOW_MINUTES = 60;

/**
 * Tokens recorded recently by THIS process.
 *
 * A burst usually lands on one instance, so this absorbs it without a database
 * round trip at all. It is an optimisation, not the control: the database check
 * below is what holds across instances and restarts.
 */
const recentlyRecorded = new Map<string, number>();
const MEMO_MAX_ENTRIES = 500;

function seenRecently(token: string, now: number): boolean {
  const at = recentlyRecorded.get(token);
  return at !== undefined && now - at < RECORD_WINDOW_MINUTES * 60_000;
}

function remember(token: string, now: number): void {
  if (recentlyRecorded.size >= MEMO_MAX_ENTRIES) {
    // Cheap eviction: drop whatever is oldest rather than grow without bound.
    const oldest = [...recentlyRecorded.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) recentlyRecorded.delete(oldest[0]);
  }
  recentlyRecorded.set(token, now);
}

/**
 * 🍯 HONEYTOKEN — this URL is embedded in the decoy payload. Anyone who calls
 * it, by any method, took it out of the database and used it. That is
 * exfiltration, observed rather than inferred.
 *
 * The response is identical whether or not the token is real, so an attacker
 * probing URLs learns nothing about which ones matter. No-store matters too: a
 * CDN caching this would swallow every hit after the first.
 */
async function handler(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;

  try {
    // A honeytoken path is 12 random bytes in base64url. Anything else cannot
    // match a row, so it is dropped before it reaches the database.
    if (token && /^[A-Za-z0-9_-]{8,64}$/.test(token)) {
      await record(token, req.method);
    }
  } catch (err) {
    // The response must not depend on whether recording worked.
    console.error('[honeytoken] failed to record hit:', err);
  }

  return NextResponse.json({ status: 'received' }, { headers: { 'cache-control': 'no-store, max-age=0' } });
}

async function record(token: string, method: string): Promise<void> {
  const now = Date.now();
  if (seenRecently(token, now)) return;

  const canary = await findCanaryByHoneytoken(token);
  if (!canary) return;

  // Deliberately state-agnostic. A hit on a RETIRED or COMPROMISED canary is
  // the most important hit there is: the payload carrying this URL is already
  // out in the world, and somebody is using it. The old lookup required
  // status='planted', so recovery — which retires the old decoys — switched off
  // detection for exactly the tokens most likely to be used next.
  const generation =
    canary.status === 'planted'
      ? 'currently planted'
      : canary.status === 'retired'
        ? 'retired during recovery — this payload leaked before the decoys were replaced'
        : `marked ${canary.status}`;

  remember(token, now);

  // Two counts, both taken BEFORE anything is written, because after the insert
  // neither question can be answered without ambiguity.
  const [inWindow, inHour] = await Promise.all([
    countRecentHoneytokenHits(canary.id, RECORD_WINDOW_MINUTES),
    countRecentHoneytokenHits(canary.id, ALERT_WINDOW_MINUTES),
  ]);

  // Authoritative across instances: one recorded event per canary per window.
  if (inWindow > 0) return;

  const detail = `Honeytoken for decoy ${canary.markerToken} was requested (${method}). That URL exists only inside a decoy row, so the data holding it left your database and is being used. Decoy is ${generation}.`;

  await insertCanaryEvents([
    {
      projectId: canary.projectId,
      canaryId: canary.id,
      kind: 'honeytoken_hit',
      detail,
      source: 'honeytoken',
    },
  ]);

  // The alert decision is made HERE, where it is exact: zero prior hits in the
  // hour means this is the first, and the first is the one worth an email. The
  // worker used to decide by counting hits after the row was written, so its
  // own hit inflated the count — and two hits arriving close together made
  // every count exceed the threshold, suppressing the alert entirely and
  // sending nothing at all for the product's strongest signal.
  if (inHour > 0) return;

  try {
    await inngest.send({
      name: EVENTS.canaryHoneytokenHit,
      data: { projectId: canary.projectId, canaryId: canary.id, token, method, detail },
    });
  } catch (err) {
    // The event row is already written; a queue failure must not fail the response.
    console.error('[honeytoken] failed to enqueue alert:', err);
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;

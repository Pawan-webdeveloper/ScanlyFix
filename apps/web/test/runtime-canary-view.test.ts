import { describe, expect, it } from 'vitest';

import {
  STATUS_LEGEND_ROWS,
  decoyLabel,
  deriveBanner,
  deriveState,
  eventLegend,
  integrityLegend,
  isIntrusion,
  statusLegend,
  type CanaryEventRow,
  type CanaryRow,
} from '../app/(app)/runtime/canaries/canary-view';

/**
 * What the customer is shown.
 *
 * These are not cosmetic assertions. The console's job is to say one of two
 * things — "nothing has touched your data" or "something has" — and the third
 * state, "we could not look", is the one that gets silently rendered as the
 * first. Every test here pins a case where the old console said the wrong one.
 */

const decoy = (over: Partial<CanaryRow> = {}): CanaryRow => ({
  marker: 'CANARY::proj1234::ab12cd::A',
  kind: 'vault',
  status: 'planted',
  integrity: 'ok',
  lastCheckedAt: '2026-09-14T22:10:00.000Z',
  ...over,
});

const selfTestRow = (over: Partial<CanaryRow> = {}): CanaryRow => ({
  marker: 'CANARY::proj1234::ab12cd::SELFTEST',
  kind: 'selftest',
  status: 'planted',
  integrity: 'ok',
  lastCheckedAt: '2026-09-14T22:10:00.000Z',
  ...over,
});

const event = (over: Partial<CanaryEventRow> = {}): CanaryEventRow => ({
  id: 'evt-1',
  kind: 'modified',
  detail: 'Decoy row A was rewritten.',
  source: 'trigger_log',
  detectedAt: '2026-09-14T23:00:00.000Z',
  acknowledgedAt: null,
  ...over,
});

describe('deriveState — the stage a project is actually in', () => {
  it('stays live when every decoy is compromised', () => {
    // The old console derived a single `planted` boolean as "some canary has
    // status planted". A full compromise flips them all to `compromised`, so it
    // went false — hiding every recovery control and re-showing onboarding at
    // the exact moment the customer needed to re-plant.
    const state = deriveState([decoy({ status: 'compromised' }), decoy({ marker: 'm2', status: 'compromised' })], true);

    expect(state.stage).toBe('live');
    expect(state.compromised).toHaveLength(2);
  });

  it('separates the self-test row from the decoys', () => {
    const state = deriveState([decoy(), selfTestRow()], true);
    expect(state.decoys).toHaveLength(1);
    expect(state.selfTest?.kind).toBe('selftest');
  });

  it('is not live on the self-test row alone', () => {
    // A set that somehow lost its decoys but kept the self-test is not watching
    // anything, and must not present as if it were.
    expect(deriveState([selfTestRow()], true).stage).toBe('needs_script');
  });

  it('reports the disconnected, un-scripted and half-done stages distinctly', () => {
    expect(deriveState([decoy()], false).stage).toBe('disconnected');
    expect(deriveState([], true).stage).toBe('needs_script');
    expect(deriveState([decoy({ status: 'pending_script', integrity: null })], true).stage).toBe('awaiting_sql');
  });

  it('takes the newest check time across decoys, ignoring the ones never checked', () => {
    const state = deriveState(
      [
        decoy({ marker: 'a', lastCheckedAt: '2026-09-10T00:00:00.000Z' }),
        decoy({ marker: 'b', lastCheckedAt: null }),
        decoy({ marker: 'c', lastCheckedAt: '2026-09-14T09:30:00.000Z' }),
      ],
      true,
    );
    expect(state.lastVerifiedAt).toBe('2026-09-14T09:30:00.000Z');
  });

  it('reports no check time at all rather than a misleading one', () => {
    expect(deriveState([decoy({ lastCheckedAt: null })], true).lastVerifiedAt).toBeNull();
  });
});

describe('deriveBanner — the one sentence the customer reads', () => {
  const live = (rows: CanaryRow[]) => deriveState(rows, true);

  it('is green only when decoys are intact and nothing is outstanding', () => {
    const banner = deriveBanner(live([decoy(), decoy({ marker: 'b' })]), []);
    expect(banner.tone).toBe('ok');
    expect(banner.title).toMatch(/no decoy row has been touched/i);
    expect(banner.body).toContain('2 decoy rows');
  });

  it('never says all clear while the detector could not be confirmed', () => {
    // This is the whole point of the feature: silence from a detector that is
    // not running looks exactly like silence from a database nobody touched.
    const banner = deriveBanner(live([decoy()]), [event({ kind: 'watch_disabled' })]);
    expect(banner.tone).toBe('warn');
    expect(banner.title).toMatch(/not confirmed/i);
    expect(banner.body).toMatch(/silence right now does not mean all clear/i);
  });

  it('treats an unreachable database as not-verified, not as an intrusion', () => {
    const banner = deriveBanner(live([decoy({ integrity: 'unreachable' })]), [event({ kind: 'unreachable' })]);
    expect(banner.tone).toBe('warn');
    expect(banner.tone).not.toBe('critical');
  });

  it('puts a real compromise above everything else', () => {
    const banner = deriveBanner(live([decoy({ status: 'compromised', integrity: 'modified' })]), [
      event({ kind: 'watch_disabled' }),
    ]);
    expect(banner.tone).toBe('critical');
    expect(banner.title).toMatch(/1 decoy row was touched/i);
    expect(banner.body).toMatch(/not a false positive/i);
  });

  it('pluralises the compromise headline', () => {
    const rows = [decoy({ marker: 'a', status: 'compromised' }), decoy({ marker: 'b', status: 'compromised' })];
    expect(deriveBanner(live(rows), []).title).toMatch(/2 decoy rows were touched/i);
  });

  it('surfaces a honeytoken hit even when every row is still intact', () => {
    // Exfiltration leaves the rows untouched by definition — the data was read,
    // not written — so a state-only banner would call this night quiet.
    const banner = deriveBanner(live([decoy()]), [event({ kind: 'honeytoken_hit', source: 'honeytoken' })]);
    expect(banner.tone).toBe('critical');
    expect(banner.title).toMatch(/honeytoken/i);
  });

  it('ignores events that have already been reviewed', () => {
    // Acknowledged events are history. Only the unreviewed set is passed in, so
    // a project that dealt with an incident goes back to green.
    const banner = deriveBanner(live([decoy()]), []);
    expect(banner.tone).toBe('ok');
  });

  it('says nothing is being watched before the SQL has been run', () => {
    const banner = deriveBanner(live([decoy({ status: 'pending_script', integrity: null })]), []);
    expect(banner.tone).toBe('warn');
    expect(banner.body).toMatch(/nothing is being watched/i);
  });

  it('does not claim a green state while disconnected', () => {
    expect(deriveBanner(deriveState([], false), []).tone).toBe('neutral');
  });
});

describe('legends — no raw enum ever reaches the customer', () => {
  it('translates every status the engine can write', () => {
    for (const value of ['planted', 'compromised', 'pending_script', 'retired']) {
      const legend = statusLegend(value);
      expect(legend.label).not.toBe('Unknown');
      expect(legend.label).not.toContain('_');
      expect(legend.meaning.length).toBeGreaterThan(20);
    }
  });

  it('translates every integrity verdict', () => {
    for (const value of ['ok', 'modified', 'missing', 'unreachable']) {
      expect(integrityLegend(value)?.label).not.toBe('Unknown');
    }
    expect(integrityLegend(null)).toBeNull();
  });

  it('translates every event kind the engine can emit', () => {
    const kinds = [
      'modified',
      'deleted',
      'anon_readable',
      'log_wiped',
      'honeytoken_hit',
      'table_missing',
      'watch_disabled',
      'unreachable',
    ];
    for (const kind of kinds) {
      const legend = eventLegend(kind);
      expect(legend.label).not.toBe(kind);
      expect(legend.meaning.length).toBeGreaterThan(20);
    }
  });

  it('degrades to the raw value rather than throwing on something newer', () => {
    // Forward compatibility: a checker deployed ahead of this page must not
    // render a blank badge or crash the timeline.
    const legend = eventLegend('some_future_kind');
    expect(legend.label).toBe('some_future_kind');
    expect(legend.tone).toBe('neutral');
    expect(statusLegend('brand_new').label).toBe('Unknown');
  });

  it('does not colour a blind spot as an intrusion', () => {
    expect(eventLegend('watch_disabled').tone).toBe('warn');
    expect(eventLegend('unreachable').tone).toBe('warn');
    expect(isIntrusion('watch_disabled')).toBe(false);
    expect(isIntrusion('unreachable')).toBe(false);
    for (const kind of ['modified', 'deleted', 'honeytoken_hit', 'log_wiped', 'anon_readable']) {
      expect(isIntrusion(kind)).toBe(true);
    }
  });

  it('explains every badge the decoy table can show', () => {
    expect(STATUS_LEGEND_ROWS.map((l) => l.label)).toEqual(['Watching', 'Touched', 'Awaiting SQL']);
  });
});

describe('decoyLabel', () => {
  it('names a decoy by its trailing label rather than the whole token', () => {
    expect(decoyLabel('CANARY::proj1234::ab12cd::A')).toBe('Decoy A');
    expect(decoyLabel('CANARY::proj1234::ab12cd::SELFTEST')).toBe('Decoy SELFTEST');
  });

  it('falls back to the marker when it has no label segment', () => {
    expect(decoyLabel('legacy-marker')).toBe('legacy-marker');
    expect(decoyLabel('CANARY::')).toBe('CANARY::');
  });
});

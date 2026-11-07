import { describe, expect, it } from 'vitest';
import type { AnyFeedEvent } from '@sportlight/shared';
import { FeedStore } from './feed-store.js';

const timing = { staleAfterMs: 5_000, silentAfterMs: 15_000, expireAfterMs: 120_000, endedRetentionMs: 60_000 };
const T0 = Date.parse('2026-11-07T12:00:00Z');
let n = 0;

function ev<T extends AnyFeedEvent['type']>(
  type: T,
  seq: number,
  payload: Extract<AnyFeedEvent, { type: T }>['payload'],
  opts: { runId?: string; runStartedAt?: number; eventId?: string } = {},
): AnyFeedEvent {
  return {
    schemaVersion: 1,
    type,
    eventId: opts.eventId ?? `e${++n}`,
    provider: 'mock',
    feedId: 'f1',
    runId: opts.runId ?? 'r1',
    runStartedAt: new Date(opts.runStartedAt ?? T0).toISOString(),
    seq,
    occurredAt: new Date(T0 + seq * 1000).toISOString(),
    payload,
  } as AnyFeedEvent;
}

const started = (seq = 0, opts = {}) =>
  ev(
    'feed.started',
    seq,
    {
      sportId: 'football',
      event: { title: 'A v B' },
      source: { kind: 'looping-mp4', url: '/m.mp4', durationSec: 60, mediaOffsetSec: 0, hasAudio: true },
    },
    opts,
  );
const intensity = (seq: number, score: number, opts = {}) =>
  ev('feed.intensity', seq, { score, streamTime: seq }, opts);

describe('FeedStore ordering', () => {
  it('applies in-order events', () => {
    const s = new FeedStore(timing);
    expect(s.apply(started(), T0).kind).toBe('applied');
    expect(s.apply(intensity(1, 40), T0 + 1000).kind).toBe('applied');
    expect(s.get('f1')?.intensity?.score).toBe(40);
  });

  it('drops redelivered events by id', () => {
    const s = new FeedStore(timing);
    s.apply(started(), T0);
    const e = intensity(1, 40);
    s.apply(e, T0);
    expect(s.apply(e, T0)).toEqual({ kind: 'dropped', reason: 'duplicate' });
  });

  it('never lets a delayed reading overwrite newer state, but surfaces it for history', () => {
    const s = new FeedStore(timing);
    s.apply(started(), T0);
    s.apply(intensity(5, 90), T0);
    const late = s.apply(intensity(3, 10), T0);
    expect(late.kind).toBe('late-intensity');
    expect(s.get('f1')?.intensity?.score).toBe(90);
  });

  it('ignores events for unknown feeds and outdated runs', () => {
    const s = new FeedStore(timing);
    expect(s.apply(intensity(1, 50), T0)).toEqual({ kind: 'dropped', reason: 'unknown-feed' });
    s.apply(started(0, { runId: 'r2', runStartedAt: T0 + 60_000 }), T0);
    expect(s.apply(intensity(9, 50, { runId: 'r1', runStartedAt: T0 }), T0)).toEqual({
      kind: 'dropped',
      reason: 'stale-run',
    });
  });

  it('does not resurrect an ended run', () => {
    const s = new FeedStore(timing);
    s.apply(started(), T0);
    s.apply(ev('feed.ended', 2, { reason: 'completed' }), T0);
    expect(s.get('f1')?.status).toBe('ended');
    expect(s.apply(intensity(3, 50), T0)).toEqual({ kind: 'dropped', reason: 'after-end' });
    // A new run may start again.
    const next = s.apply(started(0, { runId: 'r2', runStartedAt: T0 + 120_000 }), T0);
    expect(next.kind).toBe('applied');
    expect(s.get('f1')?.status).toBe('live');
  });

  it('tracks provider availability and silence', () => {
    const s = new FeedStore(timing);
    s.apply(started(), T0);
    s.apply(ev('feed.updated', 1, { availability: 'unavailable' }), T0);
    expect(s.get('f1')).toMatchObject({ status: 'unavailable', unavailableReason: 'provider' });
    s.apply(ev('feed.updated', 2, { availability: 'available' }), T0);
    expect(s.get('f1')?.status).toBe('live');

    s.apply(intensity(3, 50), T0);
    expect(s.tick(T0 + 6_000).changed[0]?.intensityStale).toBe(true);
    s.tick(T0 + 16_000);
    expect(s.get('f1')).toMatchObject({ status: 'unavailable', unavailableReason: 'silent' });
    s.apply(intensity(4, 50), T0 + 17_000);
    expect(s.get('f1')?.status).toBe('live');
    const t = s.tick(T0 + 17_000 + 121_000);
    expect(t.ended).toHaveLength(1);
    expect(s.tick(T0 + 17_000 + 121_000 + 61_000).removed).toEqual(['f1']);
  });
});

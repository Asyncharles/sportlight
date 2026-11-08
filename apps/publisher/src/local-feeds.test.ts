import { describe, expect, it } from 'vitest';
import { FeedEventSchema } from '@sportlight/shared/schemas';
import {
  LOCAL_DATASET,
  LOCAL_EXTRA_DATASET,
  hasDemoClips,
  isExtraFeed,
  localFeeds,
  publishedLocalFeeds,
} from './local-feeds.js';
import { planLive } from './live-slots.js';

const event = { title: "Men's 79 kg, Group A", subtitle: 'Worlds 2025', broadcaster: { name: 'Weightlifting House' } };

describe('local engine feeds', () => {
  it('uses the engine feed id, keeps the competition and pins the feed', () => {
    const feeds = localFeeds([
      { id: 'wl-demo-session', dataset: LOCAL_DATASET, sportId: 'weightlifting', competitionId: 'iwf-worlds', event },
      { id: 'other', dataset: 'commons-open-v1', sportId: 'cycling', event },
      { id: 'unknown-sport', dataset: LOCAL_DATASET, sportId: 'darts', event },
    ]);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ id: 'wl-demo-session', clipId: 'wl-demo-session', sportId: 'weightlifting', competitionId: 'iwf-worlds', pinned: true, ...event });
  });

  it('adds the tuning clips as ordinary, unpinned feeds', () => {
    const feeds = localFeeds([
      { id: 'wl-2025-m71', dataset: LOCAL_EXTRA_DATASET, sportId: 'weightlifting', event },
      { id: 'wl-demo-session', dataset: LOCAL_DATASET, sportId: 'weightlifting', event },
    ]);
    expect(feeds.map((f) => [f.id, f.pinned ?? false])).toEqual([
      ['wl-2025-m71', false],
      ['wl-demo-session', true],
    ]);
    expect(feeds.every((f) => f.peaks.every((p) => p.at < 900))).toBe(true);
  });

  it('leaves the demo feeds to SportlightEngine when it publishes them, and still hides the rest', () => {
    const clips = [
      { id: 'wl-demo-session', dataset: LOCAL_DATASET, sportId: 'weightlifting', event },
      { id: 'wl-2025-m71', dataset: LOCAL_EXTRA_DATASET, sportId: 'weightlifting', event },
    ];
    expect(publishedLocalFeeds(clips, false).map((f) => f.id)).toEqual(['wl-demo-session', 'wl-2025-m71']);
    const ours = publishedLocalFeeds(clips, true);
    expect(ours.map((f) => f.id)).toEqual(['wl-2025-m71']);
    // The demo clips are still in the catalog, so the tuning clip stays an extra feed.
    expect(hasDemoClips(clips)).toBe(true);
    expect(isExtraFeed(ours[0]!, hasDemoClips(clips))).toBe(true);
  });

  it('marks nothing extra on a deployment without the demo clips', () => {
    const clips = [{ id: 'open-cycling-1', dataset: 'commons-open-v1', sportId: 'cycling', event }];
    expect(hasDemoClips(clips)).toBe(false);
    expect(isExtraFeed({}, hasDemoClips(clips))).toBe(false);
    expect(isExtraFeed({ pinned: true }, true)).toBe(false);
  });

  it('carries the extra flag through the feed.started contract', () => {
    const started = {
      schemaVersion: 1, type: 'feed.started', eventId: 'e1', provider: 'p', feedId: 'f', runId: 'r',
      runStartedAt: new Date(0).toISOString(), seq: 1, occurredAt: new Date(0).toISOString(),
      payload: {
        sportId: 'football',
        event: { title: 'Croatia v Brazil', extra: true },
        source: { kind: 'looping-mp4', url: '/media/x.mp4', durationSec: 10, mediaOffsetSec: 0, hasAudio: true },
      },
    };
    const parsed = FeedEventSchema.parse(started);
    expect(parsed.type === 'feed.started' && parsed.payload.event.extra).toBe(true);
  });
});

describe('pinned feeds in the live-slot cap', () => {
  const base = { lastEndedMs: new Map<string, number>(), now: 1_000_000, rotateMs: 300_000 };
  const others = Array.from({ length: 10 }, (_, i) => `o${i}`);

  it('always start, and take slots before rotating feeds', () => {
    const plan = planLive({ ...base, wanted: [...others, 'p1', 'p2'], running: new Map(), max: 5, pinned: new Set(['p1', 'p2']) });
    expect(plan.start).toEqual(['p1', 'p2', 'o0', 'o1', 'o2']);
  });

  it('are never rotated out, however long they have run', () => {
    const running = new Map([['p1', 0], ['o0', 0]]);
    const plan = planLive({ ...base, wanted: ['p1', ...others], running, max: 2, pinned: new Set(['p1']) });
    expect(plan.stop).toEqual(['o0']);
    expect(plan.start).toEqual(['o1']);
  });

  it('push every other feed off air when they fill the cap', () => {
    const running = new Map([['o0', base.now]]);
    const plan = planLive({ ...base, wanted: ['p1', 'p2', 'o0'], running, max: 2, pinned: new Set(['p1', 'p2']) });
    expect(plan).toEqual({ start: ['p1', 'p2'], stop: ['o0'] });
  });
});

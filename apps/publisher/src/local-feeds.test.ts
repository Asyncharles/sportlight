import { describe, expect, it } from 'vitest';
import { LOCAL_DATASET, localFeeds } from './local-feeds.js';
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

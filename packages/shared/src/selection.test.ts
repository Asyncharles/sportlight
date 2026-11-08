import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from './config.js';
import type { FeedState, Follow } from './domain.js';
import {
  assign,
  emptySelection,
  hurry,
  keep,
  promote,
  reconcile,
  setPinned,
  type SelectionState,
  type ViewerSelectionOptions,
} from './selection.js';

const config = DEFAULT_SELECTION_CONFIG;
const allSports: Follow[] = ['football', 'tennis', 'chess', 'esports', 'rugby', 'cycling'].map((id) => ({
  kind: 'sport',
  id,
}));

function feed(id: string, score: number, patch: Partial<FeedState> = {}): FeedState {
  return {
    id,
    runId: `${id}-run`,
    provider: 'test',
    sportId: patch.sportId ?? 'football',
    event: { title: id },
    source: { kind: 'looping-mp4', url: `/media/${id}.mp4`, durationSec: 60, mediaOffsetSec: 0, hasAudio: true },
    status: 'live',
    startedAt: new Date(0).toISOString(),
    intensity: { score, streamTime: 0, at: new Date(0).toISOString() },
    intensityStale: false,
    seq: 1,
    votes: { up: 0, down: 0 },
    ...patch,
  };
}

function run(
  state: SelectionState,
  feeds: FeedState[],
  now: number,
  follows = allSports,
  votes = {},
  options: ViewerSelectionOptions = {},
) {
  return reconcile(state, { feeds, follows, votes, now, config, ...options });
}

const ids = (s: SelectionState) => [
  s.slots.main?.feedId,
  s.slots['side-1']?.feedId,
  s.slots['side-2']?.feedId,
  s.slots['side-3']?.feedId,
];

describe('reconcile', () => {
  it('places the highest-ranked feed in main and fills sides by rank', () => {
    const { state } = run(
      emptySelection(),
      [feed('a', 40), feed('b', 90), feed('c', 70), feed('d', 60), feed('e', 10)],
      0,
    );
    expect(ids(state)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('handles fewer than four feeds and an empty selection', () => {
    expect(ids(run(emptySelection(), [feed('a', 40)], 0).state)).toEqual(['a', undefined, undefined, undefined]);
    expect(ids(run(emptySelection(), [], 0).state)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('only shows feeds matching the viewer follows, and applies filter changes immediately', () => {
    const feeds = [feed('f1', 90), feed('t1', 50, { sportId: 'tennis' }), feed('t2', 40, { sportId: 'tennis' })];
    const tennisOnly: Follow[] = [{ kind: 'sport', id: 'tennis' }];
    const first = run(emptySelection(), feeds, 0, tennisOnly).state;
    expect(ids(first)).toEqual(['t1', 't2', undefined, undefined]);

    const footballOnly: Follow[] = [{ kind: 'sport', id: 'football' }];
    const { state, changes } = run(first, feeds, 1000, footballOnly);
    expect(ids(state)).toEqual(['f1', undefined, undefined, undefined]);
    expect(changes).toContainEqual({ type: 'removed', slot: 'main', feedId: 't1', reason: 'filtered' });
  });

  it('does not reorder visible windows when scores change', () => {
    const s1 = run(emptySelection(), [feed('a', 90), feed('b', 80), feed('c', 70), feed('d', 60)], 0).state;
    const s2 = run(s1, [feed('a', 10), feed('b', 20), feed('c', 95), feed('d', 99)], 60_000).state;
    expect(ids(s2)).toEqual(ids(s1));
  });

  it('replaces the weakest side feed only after the margin holds for the challenge time', () => {
    const base = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50)];
    let s = run(emptySelection(), [...base, feed('x', 20)], 0).state;
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd']);

    const hot = [...base, feed('x', 61)]; // beats d (50) by 11
    s = run(s, hot, 25_000).state;
    expect(s.slots['side-3']?.feedId).toBe('d'); // challenge just started
    s = run(s, hot, 27_000).state;
    expect(s.slots['side-3']?.feedId).toBe('d');
    const { state, changes } = run(s, hot, 28_000);
    expect(state.slots['side-3']?.feedId).toBe('x');
    expect(changes).toContainEqual({ type: 'replaced', slot: 'side-3', feedId: 'x', previous: 'd' });
  });

  it('resets the challenge when the margin is lost (brief spikes do not swap feeds)', () => {
    const base = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50)];
    let s = run(emptySelection(), [...base, feed('x', 20)], 0).state;
    s = run(s, [...base, feed('x', 70)], 25_000).state;
    s = run(s, [...base, feed('x', 55)], 26_000).state; // margin lost
    s = run(s, [...base, feed('x', 70)], 27_000).state;
    s = run(s, [...base, feed('x', 70)], 29_500).state;
    expect(s.slots['side-3']?.feedId).toBe('d');
    s = run(s, [...base, feed('x', 70)], 30_000).state;
    expect(s.slots['side-3']?.feedId).toBe('x');
  });

  it('respects the minimum display time', () => {
    const base = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50)];
    let s = run(emptySelection(), base, 0).state;
    // x goes live hot at t=1s; every side feed is still within its minimum display time.
    for (let t = 1000; t < 20_000; t += 1000) s = run(s, [...base, feed('x', 99)], t).state;
    expect(ids(s)).not.toContain('x');
    for (let t = 20_000; t <= 23_000; t += 1000) s = run(s, [...base, feed('x', 99)], t).state;
    expect(s.slots['side-3']?.feedId).toBe('x');
  });

  it('ignores stale challengers', () => {
    const base = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50)];
    let s = run(emptySelection(), base, 0).state;
    const stale = feed('x', 99, { intensityStale: true });
    for (let t = 20_000; t <= 30_000; t += 1000) s = run(s, [...base, stale], t).state;
    expect(ids(s)).not.toContain('x');
  });

  it('replaces ended or unavailable feeds immediately, ignoring display time', () => {
    const feeds = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50), feed('e', 10)];
    const s = run(emptySelection(), feeds, 0).state;
    const next = run(
      s,
      feeds.map((f) => (f.id === 'c' ? { ...f, status: 'ended' as const } : f)),
      1000,
    );
    expect(next.state.slots['side-2']?.feedId).toBe('e');
    expect(next.changes).toContainEqual({ type: 'removed', slot: 'side-2', feedId: 'c', reason: 'ended' });
  });

  it('keeps the user choice in main, and refills main from the best visible feed when it ends', () => {
    const feeds = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50), feed('e', 40)];
    let s = run(emptySelection(), feeds, 0).state;
    s = promote(s, 'd', 1000);
    expect(ids(s)).toEqual(['d', 'b', 'c', 'a']);
    // Main never auto-follows intensity.
    s = run(
      s,
      feeds.map((f) => (f.id === 'b' ? { ...f, intensity: { ...f.intensity!, score: 100 } } : f)),
      90_000,
    ).state;
    expect(s.slots.main?.feedId).toBe('d');
    // Main ends → highest-ranked visible side feed moves up (keeping its player), side refilled.
    const { state, changes } = run(
      s,
      feeds.map((f) => (f.id === 'd' ? { ...f, status: 'ended' as const } : f)),
      91_000,
    );
    expect(ids(state)).toEqual(['a', 'b', 'c', 'e']);
    expect(changes).toContainEqual({ type: 'moved', from: 'side-3', to: 'main', feedId: 'a' });
  });

  it('applies personal votes to ranking', () => {
    const feeds = [feed('a', 80), feed('b', 75)];
    const { state } = run(emptySelection(), feeds, 0, allSports, { a: -1 });
    expect(state.slots.main?.feedId).toBe('b');
  });

  it('promoted feeds restart their minimum display time', () => {
    const base = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50)];
    let s = run(emptySelection(), base, 0).state;
    s = promote(s, 'd', 30_000); // a moves to side-3 with a fresh placedAt
    const hot = [
      ...base.map((f) => (f.id === 'a' ? { ...f, intensity: { ...f.intensity!, score: 5 } } : f)),
      feed('x', 99),
    ];
    for (let t = 30_000; t <= 45_000; t += 1000) s = run(s, hot, t).state;
    expect(s.slots['side-3']?.feedId).toBe('a');
  });
});

describe('viewer options', () => {
  const base = [feed('a', 90), feed('b', 70), feed('c', 60), feed('d', 50)];
  const opts = (o: ViewerSelectionOptions) => (s: SelectionState, feeds: FeedState[], now: number) =>
    run(s, feeds, now, allSports, {}, o);

  it('announces a pending switch for the countdown, then switches', () => {
    const step = opts({ countdownMs: 4000 });
    let s = step(emptySelection(), [...base, feed('x', 20)], 0).state;
    const hot = [...base, feed('x', 70)];
    s = step(s, hot, 25_000).state; // challenge starts
    let r = step(s, hot, 27_000);
    expect(r.upcoming).toEqual([]);
    r = step(r.state, hot, 28_000); // challenge window passed: countdown begins
    expect(r.upcoming).toEqual([
      { slot: 'side-3', feedId: 'x', previous: 'd', kind: 'replace', since: 28_000, at: 32_000, key: 'x' },
    ]);
    r = step(r.state, hot, 31_000);
    expect(r.state.slots['side-3']?.feedId).toBe('d');
    r = step(r.state, hot, 32_000);
    expect(r.state.slots['side-3']?.feedId).toBe('x');
    expect(r.upcoming).toEqual([]);
  });

  it('cancels a pending switch when the challenger falls back or the viewer keeps the feed', () => {
    const step = opts({ countdownMs: 4000 });
    let s = step(emptySelection(), base, 0).state;
    const hot = [...base, feed('x', 70)];
    s = step(s, hot, 25_000).state;
    s = step(s, hot, 29_000).state;
    s = step(s, [...base, feed('x', 52)], 30_000).state;
    expect(step(s, hot, 31_000).upcoming).toEqual([]);

    s = step(s, hot, 31_000).state;
    const r = step(s, hot, 35_000);
    expect(r.upcoming).toHaveLength(1);
    s = keep(r.state, 'side-3', 35_000);
    const after = step(s, hot, 45_000);
    expect(after.state.slots['side-3']?.feedId).toBe('d');
    expect(after.upcoming).toEqual([]);
  });

  it('switches immediately when hurried', () => {
    const step = opts({ countdownMs: 8000 });
    let s = step(emptySelection(), base, 0).state;
    const hot = [...base, feed('x', 70)];
    s = step(s, hot, 25_000).state;
    const r = step(s, hot, 28_000);
    expect(r.upcoming).toHaveLength(1);
    s = hurry(r.state, r.upcoming[0]!.key);
    expect(step(s, hot, 28_500).state.slots['side-3']?.feedId).toBe('x');
  });

  it('makes no automatic replacements while locked, but still removes ended feeds', () => {
    const step = opts({ locked: true });
    let s = step(emptySelection(), [...base, feed('e', 10)], 0).state;
    for (let t = 20_000; t <= 40_000; t += 1000) s = step(s, [...base, feed('e', 10), feed('x', 99)], t).state;
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd']);
    const ended = base.map((f) => (f.id === 'b' ? { ...f, status: 'ended' as const } : f));
    s = step(s, [...ended, feed('x', 99)], 41_000).state;
    expect(ids(s)).toEqual(['a', 'x', 'c', 'd']);
  });

  it('uses only the side windows the layout shows', () => {
    const step = opts({ sideSlots: ['side-1', 'side-2'] });
    let r = step(emptySelection(), base, 0);
    expect(ids(r.state)).toEqual(['a', 'b', 'c', undefined]);

    // Switching from a three-window layout drops the third.
    const full = run(emptySelection(), base, 0).state;
    r = step(full, base, 1000);
    expect(ids(r.state)).toEqual(['a', 'b', 'c', undefined]);
    expect(r.changes).toContainEqual({ type: 'removed', slot: 'side-3', feedId: 'd', reason: 'layout' });
  });

  it('follows the action in main when asked to, swapping with the side feed', () => {
    const step = opts({ mainPolicy: 'follow', countdownMs: 2000 });
    let s = step(emptySelection(), base, 0).state;
    const surge = base.map((f) => (f.id === 'c' ? { ...f, intensity: { ...f.intensity!, score: 100 } } : f));
    s = step(s, surge, 20_000).state;
    let r = step(s, surge, 23_000);
    expect(r.upcoming).toEqual([
      { slot: 'main', feedId: 'c', previous: 'a', kind: 'promote', since: 23_000, at: 25_000, key: 'main>c' },
    ]);
    r = step(r.state, surge, 25_000);
    expect(ids(r.state)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('follows the action with a single window: a hotter feed outside the layout replaces main', () => {
    const step = opts({ mainPolicy: 'follow', sideSlots: [], countdownMs: 2000 });
    let s = step(emptySelection(), base, 0).state;
    expect(ids(s)).toEqual(['a', undefined, undefined, undefined]);
    const surge = base.map((f) => (f.id === 'c' ? { ...f, intensity: { ...f.intensity!, score: 100 } } : f));
    s = step(s, surge, 20_000).state;
    let r = step(s, surge, 23_000);
    expect(r.upcoming).toEqual([
      { slot: 'main', feedId: 'c', previous: 'a', kind: 'replace', since: 23_000, at: 25_000, key: 'main>c' },
    ]);
    r = step(r.state, surge, 25_000);
    expect(ids(r.state)).toEqual(['c', undefined, undefined, undefined]);
    expect(r.changes).toContainEqual({ type: 'replaced', slot: 'main', feedId: 'c', previous: 'a' });
  });

  it('sends a feed that out-ranks main straight to main, and the old main to the weakest side window', () => {
    const step = opts({ mainPolicy: 'follow', sideSlots: ['side-1'] });
    let s = step(emptySelection(), base, 0).state;
    expect(ids(s)).toEqual(['a', 'b', undefined, undefined]);
    const hot = [...base, feed('x', 100)];
    for (let t = 20_000; t <= 30_000; t += 250) {
      s = step(s, hot, t).state;
      expect(s.slots['side-1']?.feedId).not.toBe('x'); // never hops through the side window
    }
    expect(ids(s)).toEqual(['x', 'a', undefined, undefined]); // a (90) beats b (70) for the side window
  });

  it('drops the old main when it is weaker than every side feed', () => {
    const step = opts({ mainPolicy: 'follow', sideSlots: ['side-1'] });
    let s = step(emptySelection(), base, 0).state;
    const fading = [...base.map((f) => (f.id === 'a' ? { ...f, intensity: { ...f.intensity!, score: 40 } } : f)), feed('x', 80)];
    for (let t = 20_000; t <= 30_000; t += 1000) s = step(s, fading, t).state;
    expect(ids(s)).toEqual(['x', 'b', undefined, undefined]);
  });

  it('keeps main on the viewer’s choice when a hotter feed is outside the layout', () => {
    const step = opts({ sideSlots: [] });
    let s = step(emptySelection(), base, 0).state;
    for (let t = 20_000; t <= 40_000; t += 1000) s = step(s, [...base, feed('x', 100)], t).state;
    expect(ids(s)).toEqual(['a', undefined, undefined, undefined]);
  });

  it('never replaces a pinned side window, and challenges the next weakest instead', () => {
    let s = run(emptySelection(), [...base, feed('e', 10)], 0).state;
    s = setPinned(s, 'side-3', true, 0); // d is the weakest
    for (let t = 20_000; t <= 40_000; t += 1000) s = run(s, [...base, feed('x', 99)], t).state;
    expect(ids(s)).toEqual(['a', 'b', 'x', 'd']);
    expect(s.slots['side-3']?.pinned).toBe(true);
  });

  it('does not let a pinned main be taken over, nor pull a pinned side feed into main', () => {
    const step = opts({ mainPolicy: 'follow' });
    const surge = base.map((f) => (f.id === 'c' ? { ...f, intensity: { ...f.intensity!, score: 100 } } : f));
    let s = setPinned(step(emptySelection(), base, 0).state, 'main', true, 0);
    for (let t = 20_000; t <= 40_000; t += 1000) s = step(s, surge, t).state;
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd']);
    s = setPinned(setPinned(s, 'main', false, 40_000), 'side-2', true, 40_000);
    for (let t = 41_000; t <= 80_000; t += 1000) s = step(s, surge, t).state;
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('assigns a chosen feed to a window and pins it, swapping if it is already shown', () => {
    let s = run(emptySelection(), [...base, feed('e', 10)], 0).state;
    s = assign(s, 'side-1', 'e', 1000);
    expect(ids(s)).toEqual(['a', 'e', 'c', 'd']);
    expect(s.slots['side-1']).toMatchObject({ feedId: 'e', pinned: true });
    s = assign(s, 'main', 'd', 2000);
    expect(ids(s)).toEqual(['d', 'e', 'c', 'a']);
    expect(s.slots['side-3']?.pinned).toBeUndefined();
    // Survives reconcile even though b now out-ranks it.
    s = run(s, [...base, feed('e', 10)], 60_000).state;
    expect(s.slots['side-1']).toMatchObject({ feedId: 'e', pinned: true });
  });

  it('keeps a pinned feed that no longer matches the follows while it is live', () => {
    const feeds = [...base, feed('t', 5, { sportId: 'tennis' })];
    const football: Follow[] = [{ kind: 'sport', id: 'football' }];
    let s = assign(run(emptySelection(), feeds, 0, football).state, 'side-2', 't', 0);
    s = run(s, feeds, 1000, football).state;
    expect(s.slots['side-2']?.feedId).toBe('t');
    const ended = feeds.map((f) => (f.id === 't' ? { ...f, status: 'ended' as const } : f));
    s = run(s, ended, 2000, football).state;
    expect(s.slots['side-2']?.feedId).not.toBe('t');
    expect(s.slots['side-2']?.pinned).toBeUndefined();
  });

  it('carries the pin with the feed when promoted', () => {
    let s = setPinned(run(emptySelection(), base, 0).state, 'side-2', true, 0);
    s = promote(s, 'c', 1000);
    expect(ids(s)).toEqual(['c', 'b', 'a', 'd']);
    expect(s.slots.main?.pinned).toBe(true);
    expect(s.slots['side-2']?.pinned).toBeUndefined();
  });

  it('moves the pin to the new focus when promoting over a pinned main', () => {
    let s = setPinned(run(emptySelection(), base, 0).state, 'main', true, 0);
    s = promote(s, 'c', 1000);
    expect(ids(s)).toEqual(['c', 'b', 'a', 'd']);
    expect(s.slots.main?.pinned).toBe(true);
    expect(s.slots['side-2']?.pinned).toBeUndefined();
  });

  it('unpins the feed a chosen feed swaps out of the window', () => {
    let s = assign(run(emptySelection(), base, 0).state, 'main', 'a', 0);
    expect(s.slots.main?.pinned).toBe(true);
    s = assign(s, 'main', 'c', 1000);
    expect(ids(s)).toEqual(['c', 'b', 'a', 'd']);
    expect(s.slots.main).toMatchObject({ feedId: 'c', pinned: true });
    expect(s.slots['side-2']?.pinned).toBeUndefined();
  });
});

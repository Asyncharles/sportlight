import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from './config.js';
import type { FeedState, Follow } from './domain.js';
import { emptySelection, promote, reconcile, type SelectionState } from './selection.js';

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

function run(state: SelectionState, feeds: FeedState[], now: number, follows = allSports, votes = {}) {
  return reconcile(state, { feeds, follows, votes, now, config });
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

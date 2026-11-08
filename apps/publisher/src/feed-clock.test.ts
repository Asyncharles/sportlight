import { describe, expect, it } from 'vitest';
import { mediaTimeAt } from '@sportlight/shared';
import { FeedClocks, anchorFromScore, offsetFor, parseFeedsState, streamTimeFor, toMs } from './feed-clock.js';
import { parseEngineScore, scoreTimeMs } from './engine-scores.js';

const D = 1000; // clip duration, seconds

describe('shared feed clock', () => {
  it('reads pusher start times in the shapes start_feeds.py may write', () => {
    const iso = '2026-11-08T10:00:00.000Z';
    const ms = Date.parse(iso);
    expect(parseFeedsState({ feeds: { a: { started_at: ms / 1000, duration_s: 10 } } }).get('a')).toBe(ms);
    expect(parseFeedsState({ feeds: [{ feed_id: 'b', start_time: iso }] }).get('b')).toBe(ms);
    expect(parseFeedsState({ c: { pusher_start: ms } }).get('c')).toBe(ms);
    expect(parseFeedsState({ feeds: [{ started_at: ms }] }).size).toBe(0);
    expect(toMs('nonsense')).toBeUndefined();
  });

  it('plays the browser at the engine position whenever the run started', () => {
    const clockStart = Date.parse('2026-11-08T10:00:00Z');
    const runStart = clockStart + 2_345_678; // publisher started long after the pusher, past one loop
    const offset = offsetFor(runStart, clockStart, D);
    for (const later of [0, 12_000, 700_000]) {
      const now = runStart + later;
      const browser = mediaTimeAt({ kind: 'looping-mp4', url: '', durationSec: D, mediaOffsetSec: offset, hasAudio: true }, later / 1000);
      const engine = ((now - clockStart) / 1000) % D;
      expect(browser).toBeCloseTo(engine, 2);
    }
  });

  it('maps an engine moment to the stream time the backend stores', () => {
    const clockStart = 1_000_000;
    const runStart = clockStart + 1_500_000; // 1500 s: loop 1, t_video 500
    const score = { t_video: 520, loop_epoch: 1 };
    expect(streamTimeFor(score, clockStart, runStart, D)).toBeCloseTo(20, 3);
    expect(streamTimeFor({ t_video: 400, loop_epoch: 1 }, clockStart, runStart, D)).toBeLessThan(0);
  });

  it('anchors from engine scores but ignores jitter and whole-loop renumbering', () => {
    const clocks = new FeedClocks(1000);
    const now = 5_000_000;
    expect(clocks.noteScore('f', 100, 0, D, now)).toBe(true);
    expect(clocks.startFor('f')).toBe(anchorFromScore(100, 0, D, now));
    expect(clocks.noteScore('f', 101.3, 0, D, now + 1000)).toBe(false); // 300 ms of jitter
    expect(clocks.noteScore('f', 101, 1, D, now + 1000)).toBe(false); // same position, one loop later
    expect(clocks.noteScore('f', 150, 0, D, now + 1000)).toBe(true); // a real jump
    expect(clocks.sourceOf('f')).toBe('engine');
  });

  it('prefers the pushers over engine anchors', () => {
    const clocks = new FeedClocks();
    clocks.setPusherStarts(new Map([['f', 42]]));
    expect(clocks.noteScore('f', 100, 0, D, 5_000_000)).toBe(false);
    expect(clocks.startFor('f')).toBe(42);
    expect(clocks.sourceOf('f')).toBe('pusher');
  });

  it('parses engine ScoreUpdates and rejects anything else', () => {
    const score = parseEngineScore(
      JSON.stringify({ v: 1, feed_id: 'f1-demo-race', t_video: 12.5, loop_epoch: 0, stale: false, intensity_pct: 104, reasons: [] }),
    );
    expect(score).toEqual({ feed_id: 'f1-demo-race', t_video: 12.5, loop_epoch: 0, stale: false, intensity_pct: 100 });
    expect(parseEngineScore('{"feed_id":"x"}')).toBeNull();
    expect(parseEngineScore('not json')).toBeNull();
  });

  it('times a score by when the engine stamped it, not when it arrived', () => {
    const at = 1_800_000_000_000;
    const score = { feed_id: 'f', t_video: 1, loop_epoch: 0, stale: false, intensity_pct: 50 };
    expect(scoreTimeMs({ ...score, t_emit_ns: (at - 700) * 1e6 }, at)).toBe(at - 700); // replayed on connect
    expect(scoreTimeMs({ ...score, t_emit_ns: (at - 60_000) * 1e6 }, at)).toBe(at); // clocks apart: arrival
    expect(scoreTimeMs(score, at)).toBe(at);
  });
});

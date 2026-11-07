import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGHLIGHT_CONFIG, type FeedState } from '@sportlight/shared';
import { createLogger } from '../logger.js';
import { clipWindow, MomentDetector, type Moment } from './detector.js';
import { HighlightStore } from './store.js';

const cfg = { ...DEFAULT_HIGHLIGHT_CONFIG, timezone: 'UTC' };
const T0 = Date.parse('2026-11-07T12:00:00Z');
const at = (t: number) => new Date(T0 + t * 1000).toISOString();

function feed(patch: Partial<FeedState> = {}): FeedState {
  return {
    id: 'f1',
    runId: 'r1',
    provider: 'mock',
    sportId: 'football',
    event: { title: 'A v B' },
    source: {
      kind: 'looping-mp4',
      url: '/media/a.mp4',
      durationSec: 60,
      mediaOffsetSec: 0,
      hasAudio: true,
      thumbnails: { template: '/t/{index}.jpg', intervalSec: 2, count: 30 },
    },
    status: 'live',
    startedAt: new Date(T0).toISOString(),
    intensity: null,
    intensityStale: false,
    seq: 0,
    votes: { up: 0, down: 0 },
    ...patch,
  };
}

function feedScores(d: MomentDetector, scores: number[], from = 0) {
  const out: Moment[] = [];
  scores.forEach((score, i) => {
    const m = d.push(feed(), { score, streamTime: from + i, at: at(from + i) });
    if (m) out.push(m);
  });
  return out;
}

describe('MomentDetector', () => {
  it('emits one moment per peak, after the merge gap', () => {
    const d = new MomentDetector(cfg);
    const scores = [50, 60, 80, 90, 85, 70, 60, ...Array(cfg.mergeGapSec + 1).fill(40)];
    const moments = feedScores(d, scores);
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ start: 2, peak: { score: 90, streamTime: 3 } });
  });

  it('merges peaks closer than the merge gap', () => {
    const d = new MomentDetector(cfg);
    const scores = [80, 90, 50, 50, 50, 95, 50, ...Array(cfg.mergeGapSec + 1).fill(40)];
    const moments = feedScores(d, scores);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.peak.score).toBe(95);
  });

  it('ignores brief dips thanks to hysteresis and never emits below threshold', () => {
    const d = new MomentDetector(cfg);
    expect(feedScores(d, Array(60).fill(70))).toHaveLength(0);
  });
});

describe('clipWindow', () => {
  it('adds pre/post roll and stays within bounds', () => {
    const w = clipWindow(
      { feedId: 'f', runId: 'r', start: 100, end: 104, peak: { score: 90, streamTime: 102, at: at(102) } },
      cfg,
    );
    expect(w).toEqual({ start: 94, end: 107 });
  });

  it('caps long moments around the peak', () => {
    const w = clipWindow(
      { feedId: 'f', runId: 'r', start: 100, end: 200, peak: { score: 90, streamTime: 150, at: at(150) } },
      cfg,
    );
    expect(w.end - w.start).toBeLessThanOrEqual(cfg.maxClipSec);
    expect(w.start).toBeLessThanOrEqual(150);
    expect(w.end).toBeGreaterThanOrEqual(150);
  });
});

describe('HighlightStore', () => {
  const log = createLogger('test');
  const moment = (start: number, peak: number, runId = 'r1'): Moment => ({
    feedId: 'f1',
    runId,
    start,
    end: start + 3,
    peak: { score: peak, streamTime: start + 1, at: at(start + 1) },
  });

  it('builds a replayable clip that never wraps the media loop', () => {
    const s = new HighlightStore('/tmp', cfg, log, false);
    const { upserted } = s.addMoment(moment(57, 90), feed(), () => []);
    const h = upserted[0]!;
    expect(h.clip.mediaStart).toBeGreaterThanOrEqual(0);
    expect(h.clip.mediaEnd).toBeLessThanOrEqual(60);
    expect(h.thumbnailUrl).toMatch(/^\/t\/\d+\.jpg$/);
    expect(h.day).toBe('2026-11-07');
  });

  it('merges overlapping moments of the same run', () => {
    const s = new HighlightStore('/tmp', cfg, log, false);
    const first = s.addMoment(moment(100, 85), feed(), () => []).upserted[0]!;
    const c = s.addMoment(moment(108, 92), feed(), () => []);
    expect(s.list('2026-11-07')).toHaveLength(1);
    expect(s.list('2026-11-07')[0]!.peak.score).toBe(92);
    // The merged highlight keeps its id, so clients see an in-place update rather than a swap.
    expect(c.upserted[0]!.id).toBe(first.id);
    expect(c.removed).toHaveLength(0);
  });

  it('de-duplicates clips of the same footage across loops, keeping the higher peak', () => {
    const s = new HighlightStore('/tmp', cfg, log, false);
    s.addMoment(moment(10, 95), feed(), () => []);
    // Same media position one loop (60 s) later, lower peak → dropped.
    const c = s.addMoment(moment(70, 88), feed(), () => []);
    expect(c.upserted).toHaveLength(0);
    expect(s.list('2026-11-07')).toHaveLength(1);
  });
});

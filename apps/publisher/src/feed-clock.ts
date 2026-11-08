import { mod } from '@sportlight/shared';

/**
 * The shared clock between sportlight and SportlightEngine.
 *
 * The engine's clock for a feed is `t_video`, the position in the looping source MP4 (plus a
 * `loop_epoch`). It comes from the pusher's start time: `t_video = (now − pusher start) mod duration`.
 * Sportlight plays the same MP4, so the browser lines up by playing at that same position. This
 * module works out each feed's "clock start" (the wall time at which the MP4 was at 0 in loop 0):
 *
 *  1. from the pushers' `run/feeds_state.json`, when available (authoritative, per the plan);
 *  2. otherwise from the engine's own scores: clock start = arrival − (loop_epoch × duration + t_video).
 */

/** Feed id → clock start (ms since epoch), from the pushers' `feeds_state.json`. */
export function parseFeedsState(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const root = raw && typeof raw === 'object' && 'feeds' in raw ? (raw as { feeds: unknown }).feeds : raw;
  const entries: Array<[string | undefined, unknown]> = Array.isArray(root)
    ? root.map((f) => [(f as { feed_id?: string })?.feed_id, f])
    : root && typeof root === 'object'
      ? Object.entries(root)
      : [];
  for (const [id, value] of entries) {
    if (!id || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const ms = toMs(v.started_at ?? v.start_time ?? v.pusher_start ?? v.t_wall_start);
    if (ms !== undefined) out.set(id, ms);
  }
  return out;
}

/** Epoch seconds, epoch ms or an ISO string → epoch ms. */
export function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (value.trim() !== '' && Number.isFinite(n)) return toMs(n);
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** Clock start implied by one engine score that arrived at `nowMs`. */
export function anchorFromScore(tVideo: number, loopEpoch: number, durationSec: number, nowMs: number): number {
  return nowMs - (loopEpoch * durationSec + tVideo) * 1000;
}

/**
 * Media offset for a run that started at `runStartMs`, so that the player's position
 * (`offset + (now − runStart)` mod duration) equals the engine's `(now − clockStart)` mod duration.
 */
export function offsetFor(runStartMs: number, clockStartMs: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return Math.round(mod((runStartMs - clockStartMs) / 1000, durationSec) * 1000) / 1000;
}

/** Stream time of the engine moment (loop_epoch, t_video) within a run; negative means before the run. */
export function streamTimeFor(
  score: { t_video: number; loop_epoch: number },
  clockStartMs: number,
  runStartMs: number,
  durationSec: number,
): number {
  const momentMs = clockStartMs + (score.loop_epoch * durationSec + score.t_video) * 1000;
  return Math.round(momentMs - runStartMs) / 1000;
}

export class FeedClocks {
  private pusher = new Map<string, number>();
  private engine = new Map<string, number>();

  /** Engine anchors move only when they disagree by more than this, so network jitter never seeks. */
  constructor(private readonly toleranceMs = 1000) {}

  setPusherStarts(starts: Map<string, number>) {
    this.pusher = starts;
  }

  /** Records an engine score; returns true when the feed's clock start moved. */
  noteScore(feedId: string, tVideo: number, loopEpoch: number, durationSec: number, nowMs: number): boolean {
    if (this.pusher.has(feedId)) return false;
    const anchor = anchorFromScore(tVideo, loopEpoch, durationSec, nowMs);
    const prev = this.engine.get(feedId);
    if (prev !== undefined && Math.abs(loopAware(anchor - prev, durationSec)) <= this.toleranceMs) return false;
    this.engine.set(feedId, anchor);
    return true;
  }

  /** Wall time (ms) at which the feed's MP4 was at 0 in loop 0, if known. */
  startFor(feedId: string): number | undefined {
    return this.pusher.get(feedId) ?? this.engine.get(feedId);
  }

  sourceOf(feedId: string): 'pusher' | 'engine' | undefined {
    return this.pusher.has(feedId) ? 'pusher' : this.engine.has(feedId) ? 'engine' : undefined;
  }
}

/** A whole-loop difference is the same position, e.g. when the engine restarts its loop count. */
function loopAware(diffMs: number, durationSec: number): number {
  if (durationSec <= 0) return diffMs;
  const d = durationSec * 1000;
  const m = mod(diffMs, d);
  return m > d / 2 ? m - d : m;
}

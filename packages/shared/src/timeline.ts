import type { FeedState, MediaSource } from './domain.js';

/**
 * Media-timeline helpers for the simulated-live transport.
 *
 * A run starts at wall time `startedAt` (stream time 0). Intensity readings carry a stream time, so
 * the backend can map any score to the exact media position that was playing — which is what lets
 * highlights replay the right moment.
 */

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Seconds of stream time elapsed at wall-clock `nowMs` (server-time corrected by the caller). */
export function streamTimeAt(feed: Pick<FeedState, 'startedAt'>, nowMs: number): number {
  return Math.max(0, (nowMs - Date.parse(feed.startedAt)) / 1000);
}

/** Media position for a stream-time position. */
export function mediaTimeAt(source: MediaSource, streamTime: number): number {
  if (source.durationSec <= 0) return 0;
  return mod(source.mediaOffsetSec + streamTime, source.durationSec);
}

/** The live-edge media position of a feed at wall-clock `nowMs`. */
export function liveMediaTime(feed: Pick<FeedState, 'startedAt' | 'source'>, nowMs: number): number {
  return mediaTimeAt(feed.source, streamTimeAt(feed, nowMs));
}

/**
 * Signed shortest distance from `from` to `to` on a looping timeline of `duration` seconds.
 * Positive when `to` is ahead of `from`.
 */
export function loopDelta(from: number, to: number, duration: number): number {
  if (duration <= 0) return to - from;
  const d = mod(to - from, duration);
  return d > duration / 2 ? d - duration : d;
}

/** URL of the thumbnail nearest to `mediaTime`, if the source provides a thumbnail strip. */
export function thumbnailUrlAt(source: MediaSource, mediaTime: number): string | undefined {
  const strip = source.thumbnails;
  if (!strip || strip.count === 0) return source.posterUrl;
  const index = Math.min(strip.count - 1, Math.max(0, Math.round(mediaTime / strip.intervalSec)));
  return strip.template.replace('{index}', String(index));
}

/**
 * Fit a clip window `[start, end]` (expressed relative to a peak at media time `peakMedia`) into a
 * single pass of a looping media file so it can be replayed without wrapping.
 */
export function fitClipToMedia(
  peakMedia: number,
  beforePeak: number,
  afterPeak: number,
  duration: number,
): { mediaStart: number; mediaEnd: number } {
  const length = Math.min(duration, beforePeak + afterPeak);
  let start = peakMedia - beforePeak;
  if (start < 0) start = 0;
  if (start + length > duration) start = duration - length;
  return { mediaStart: round3(start), mediaEnd: round3(start + length) };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

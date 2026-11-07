import type { EventInfo, FeedId, MediaSource, RunId, SportId } from './domain.js';

export interface Highlight {
  id: string;
  /** Calendar day (YYYY-MM-DD) of the peak in the configured timezone. */
  day: string;
  feedId: FeedId;
  runId: RunId;
  sportId: SportId;
  event: EventInfo;
  source: MediaSource;
  clip: {
    /** Stream-time range of the moment as broadcast. */
    streamStart: number;
    streamEnd: number;
    /** Replay range within the media file (never wraps the loop point). */
    mediaStart: number;
    mediaEnd: number;
    durationSec: number;
  };
  peak: { score: number; streamTime: number; at: string };
  /** Wall-clock time the clip starts (ISO). */
  startedAt: string;
  thumbnailUrl?: string;
  /** Intensity across the clip as [secondsFromClipStart, score] pairs, for the replay curve. */
  curve: Array<[number, number]>;
  /** Generated name and description. Filled in asynchronously after the highlight is cut. */
  caption?: HighlightCaption;
}

export interface HighlightCaption {
  /** Short, punchy name, e.g. "Late equaliser at the Stade de France". */
  title: string;
  /** One or two sentences describing the moment. */
  description: string;
  tags: string[];
  /** Model that wrote it (`template` when no model is configured). */
  model: string;
  generatedAt: string;
  /** Caption pipeline revision and exact source window, used to invalidate stale captions. */
  version?: string;
  sourceSignature?: string;
}

export type HighlightTier = 'large' | 'medium' | 'small';

/**
 * Tile sizes for the "Best of Today" grid, by rank within the day so the grid stays dense and
 * orderly whatever the score distribution: the top ~10% are large, the next ~25% medium, the rest
 * small. Only three sizes keep the layout calm.
 */
export function assignTiers(highlights: readonly Pick<Highlight, 'id' | 'peak'>[]): Map<string, HighlightTier> {
  const sorted = [...highlights].sort((a, b) => b.peak.score - a.peak.score);
  const large = Math.max(1, Math.round(sorted.length * 0.1));
  const medium = Math.round(sorted.length * 0.25);
  return new Map(sorted.map((h, i) => [h.id, i < large ? 'large' : i < large + medium ? 'medium' : 'small']));
}

/** YYYY-MM-DD of `date` in `timeZone`. */
export function dayKey(date: Date | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

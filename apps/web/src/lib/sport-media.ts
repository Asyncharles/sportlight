import type { FeedState, SportId } from '@sportlight/shared';
import { mediaUrl } from './env';
import { catalogMedia } from './media-catalog';

export interface SportMedia {
  poster?: string;
  video?: string;
  /** Media second to start (and loop back) to. */
  startSec: number;
}

/**
 * Poster + video for a sport: a clip from the media server's catalog (call useMediaCatalog() in the
 * component so it re-renders when that loads), else the live feed's own source.
 */
export function sportMedia(sportId: SportId, feeds: readonly FeedState[] = []): SportMedia {
  const fromCatalog = catalogMedia(sportId);
  if (fromCatalog) return fromCatalog;
  const feed = feeds.find((f) => f.sportId === sportId && f.status === 'live') ?? feeds.find((f) => f.sportId === sportId);
  return { poster: mediaUrl(feed?.source.posterUrl), video: mediaUrl(feed?.source.url), startSec: 0 };
}

/** Live feeds and the hottest current score for a sport. */
export function sportLiveStats(sportId: SportId, feeds: readonly FeedState[]) {
  const live = feeds.filter((f) => f.sportId === sportId && f.status === 'live');
  const top = live.reduce((max, f) => Math.max(max, f.intensity?.score ?? 0), 0);
  return { live: live.length, top: live.length ? Math.round(top) : null };
}

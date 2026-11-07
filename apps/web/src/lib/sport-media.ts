import type { FeedState, SportId } from '@sportlight/shared';
import { mediaUrl } from './env';

/**
 * Demo clip per sport from the bundled media build (media/dist), as [clip id, start second].
 * Some clips open on a test card, so imagery is taken from further in.
 */
const DEMO_CLIP: Record<string, [string, number]> = {
  football: ['football-fra-ger', 30],
  basketball: ['basketball-hawaii', 30],
  tennis: ['tennis-davis-cup', 30],
  motorsport: ['motorsport-formula07', 30],
  'ice-hockey': ['icehockey-rpi', 30],
  cycling: ['cycling-zottegem', 30],
  rugby: ['rugby-mixed', 30],
  athletics: ['athletics-relay', 30],
  chess: ['chess-blitz', 6],
  esports: ['esports-yokota', 30],
};
/** Thumbnail strip interval in the media build. */
const THUMB_SEC = 2;

export interface SportMedia {
  poster?: string;
  video?: string;
  /** Media second to start (and loop back) to. */
  startSec: number;
}

/** Poster + video for a sport: the curated demo clip, else the live feed's own source. */
export function sportMedia(sportId: SportId, feeds: readonly FeedState[] = []): SportMedia {
  const demo = DEMO_CLIP[sportId];
  if (demo) {
    const [clip, startSec] = demo;
    return {
      poster: mediaUrl(`/media/thumbs/${clip}/${Math.round(startSec / THUMB_SEC)}.jpg`),
      video: `${mediaUrl(`/media/videos/${clip}.mp4`)}#t=${startSec}`,
      startSec,
    };
  }
  const feed = feeds.find((f) => f.sportId === sportId && f.status === 'live') ?? feeds.find((f) => f.sportId === sportId);
  return { poster: mediaUrl(feed?.source.posterUrl), video: mediaUrl(feed?.source.url), startSec: 0 };
}

/** Live feeds and the hottest current score for a sport. */
export function sportLiveStats(sportId: SportId, feeds: readonly FeedState[]) {
  const live = feeds.filter((f) => f.sportId === sportId && f.status === 'live');
  const top = live.reduce((max, f) => Math.max(max, f.intensity?.score ?? 0), 0);
  return { live: live.length, top: live.length ? Math.round(top) : null };
}

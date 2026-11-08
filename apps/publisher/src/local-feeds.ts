import { isKnownSport } from '@sportlight/shared';
import { CYCLE_SEC, type DemoFeed } from './scenario.js';

export const LOCAL_DATASET = 'local-engine-v1';
/** The tuning clips: extra feeds with simulated intensity, never pinned or engine-scored. */
export const LOCAL_EXTRA_DATASET = 'local-extra-v1';

interface LocalClip {
  id: string;
  sportId?: string;
  competitionId?: string;
  dataset?: string;
  event?: { title: string; subtitle: string; broadcaster: DemoFeed['broadcaster'] };
}

/**
 * The engine's demo feeds, from media/dist/local/catalog.json (npm run media:local). The feed id is the
 * engine's feed_id, so engine scores map straight onto them. They are pinned: always live, never
 * rotated out for other test feeds. Without an engine connected, intensity falls back to a gentle
 * simulated signal.
 */
/** The engine's demo clips are in the catalog, so the four demo feeds are on air (from us or the engine). */
export function hasDemoClips(clips: readonly LocalClip[]): boolean {
  return clips.some((clip) => clip.dataset === LOCAL_DATASET);
}

/**
 * The local feeds this publisher announces. When SportlightEngine publishes the four demo feeds
 * itself (ENGINE_OWNS_DEMO_FEEDS), announcing them here too would make two producers fight over the
 * same feed ids, so only the extra (tuning) feeds are left.
 */
export function publishedLocalFeeds(clips: LocalClip[], engineOwnsDemoFeeds: boolean): DemoFeed[] {
  return localFeeds(clips).filter((feed) => !(engineOwnsDemoFeeds && feed.pinned));
}

/** While the demo feeds are on air, every other feed is extra: hidden until a viewer turns extra feeds on. */
export function isExtraFeed(feed: Pick<DemoFeed, 'pinned'>, demoClipsPresent: boolean): boolean {
  return !feed.pinned && demoClipsPresent;
}

export function localFeeds(clips: LocalClip[]): DemoFeed[] {
  return clips.flatMap((clip, index) => {
    const demo = clip.dataset === LOCAL_DATASET;
    if (!demo && clip.dataset !== LOCAL_EXTRA_DATASET) return [];
    if (!clip.event || !clip.sportId || !isKnownSport(clip.sportId)) return [];
    return [
      {
        id: clip.id,
        clipId: clip.id,
        sportId: clip.sportId,
        ...(clip.competitionId ? { competitionId: clip.competitionId } : {}),
        ...clip.event,
        live: [[0, CYCLE_SEC]],
        baseline: 40 + (index % 4) * 4,
        volatility: 6,
        peaks: [{ at: 120 + ((index * 180) % 780), height: 38, rise: 6, hold: 14, fall: 10 }],
        ...(demo ? { pinned: true } : {}),
      } satisfies DemoFeed,
    ];
  });
}

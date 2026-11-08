import { isKnownSport } from '@sportlight/shared';
import { CYCLE_SEC, type DemoFeed } from './scenario.js';

export const LOCAL_DATASET = 'local-engine-v1';

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
export function localFeeds(clips: LocalClip[]): DemoFeed[] {
  return clips.flatMap((clip, index) => {
    if (clip.dataset !== LOCAL_DATASET || !clip.event || !clip.sportId || !isKnownSport(clip.sportId)) return [];
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
        peaks: [{ at: 120 + index * 180, height: 38, rise: 6, hold: 14, fall: 10 }],
        pinned: true,
      } satisfies DemoFeed,
    ];
  });
}

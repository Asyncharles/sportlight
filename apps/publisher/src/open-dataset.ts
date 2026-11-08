import { isKnownSport } from '@sportlight/shared';
import { CYCLE_SEC, type DemoFeed } from './scenario.js';

interface OpenClip {
  id: string;
  sportId?: string;
  dataset?: string;
  event?: { title: string; subtitle: string; broadcaster: DemoFeed['broadcaster'] };
}

/** Real footage with explicitly simulated intensity; never invent teams or broadcaster identities. */
export function openDatasetFeeds(clips: OpenClip[]): DemoFeed[] {
  return clips.flatMap((clip, index) => {
    if (clip.dataset !== 'commons-open-v1' || !clip.event || !clip.sportId || !isKnownSport(clip.sportId)) return [];
    return [
      {
        id: clip.id,
        clipId: clip.id,
        sportId: clip.sportId,
        ...clip.event,
        live: [[0, CYCLE_SEC]],
        baseline: 28 + (index % 7) * 4,
        volatility: 5,
        peaks: [{ at: 30 + ((index * 47) % 800), height: 42, rise: 6, hold: 12, fall: 8 }],
      } satisfies DemoFeed,
    ];
  });
}

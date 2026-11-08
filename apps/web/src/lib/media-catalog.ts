import { useEffect, useSyncExternalStore } from 'react';
import { mediaUrl } from './env';

/**
 * One clip per sport for decorative imagery (landing page, tour tiles), picked from what the media
 * server actually serves: /media/catalog.json (the open Commons set) and, when the private demo
 * footage is mounted, /media/local/catalog.json (the engine demo feeds, preferred).
 */

interface CatalogClip {
  id: string;
  sportId?: string;
  dataset?: string;
  synthetic?: boolean;
  video: string;
  poster?: string;
  durationSec: number;
  height?: number;
  startOffsetSec?: number;
  thumbnails?: { template: string; intervalSec: number; count: number };
}

export interface CatalogMedia {
  poster?: string;
  video: string;
  /** Media second to start (and loop back) to. */
  startSec: number;
}

/** Lower is preferred: our real demo broadcasts, then the open set, then anything else. */
const RANK: Record<string, number> = { 'local-engine-v1': 0, 'commons-open-v1': 1 };

/**
 * Modern, colour clips in the open set (media/open-sources.json). Most of the set is 1930s–40s
 * newsreel, which looks dated as landing imagery, so these win where a sport has one.
 */
const MODERN = new Set([
  'open-football-195293968', // German-American Spring Cup, 1080p
  'open-basketball-195820790', // Sasebo youth basketball, 1080p
  'open-motorsport-45770980', // 2015 Punta del Este ePrix
  'open-athletics-48714241', // Invictus Games 2016, 1080p
  'open-rugby-66179715', // 2019 Rugby World Cup qualifier
  'open-chess-17615233', // Ordix Open 2004
]);

/** Sort key, lower first: source, then curated modern clips, higher resolution, longer. */
function preference(c: CatalogClip): number[] {
  return [RANK[c.dataset ?? ''] ?? 2, MODERN.has(c.id) ? 0 : 1, -(c.height ?? 0), -c.durationSec];
}

function better(a: CatalogClip, b: CatalogClip): boolean {
  const pa = preference(a);
  const pb = preference(b);
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]!;
  return false;
}

export function pickSportMedia(clips: readonly CatalogClip[]): Map<string, CatalogMedia> {
  const best = new Map<string, CatalogClip>();
  for (const clip of clips) {
    if (!clip.sportId || clip.synthetic || !clip.video || !(clip.durationSec > 0)) continue;
    const prev = best.get(clip.sportId);
    if (!prev || better(clip, prev)) best.set(clip.sportId, clip);
  }
  const out = new Map<string, CatalogMedia>();
  for (const [sport, clip] of best) {
    const thumbs = clip.thumbnails;
    // Skip openings (test cards, walk-ons); the engine clips are already cut to the action.
    const wanted = clip.startOffsetSec || (clip.dataset === 'local-engine-v1' ? 60 : 30);
    const startSec = Math.max(0, Math.min(wanted, clip.durationSec * 0.2));
    const index = thumbs ? Math.min(thumbs.count - 1, Math.floor(startSec / thumbs.intervalSec)) : -1;
    const poster =
      thumbs && index >= 0 ? thumbs.template.replace('{index}', String(index)) : (clip.poster ?? undefined);
    out.set(sport, {
      poster: poster ? mediaUrl(`/media/${poster}`) : undefined,
      video: `${mediaUrl(`/media/${clip.video}`)}#t=${startSec}`,
      startSec,
    });
  }
  return out;
}

let bySport = new Map<string, CatalogMedia>();
let version = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

async function fetchClips(path: string): Promise<CatalogClip[]> {
  try {
    const res = await fetch(mediaUrl(path)!, { cache: 'no-cache' });
    if (!res.ok) return [];
    const body = (await res.json()) as { clips?: CatalogClip[] };
    return Array.isArray(body.clips) ? body.clips : [];
  } catch {
    return [];
  }
}

export function loadMediaCatalog(): Promise<void> {
  loading ??= Promise.all([fetchClips('/media/catalog.json'), fetchClips('/media/local/catalog.json')]).then(
    ([open, local]) => {
      bySport = pickSportMedia([...local, ...open]);
      version++;
      listeners.forEach((l) => l());
    },
  );
  return loading;
}

/** The catalog clip for a sport, if the catalog has loaded and has one. */
export function catalogMedia(sportId: string): CatalogMedia | undefined {
  return bySport.get(sportId);
}

/** Loads the catalog once; re-renders the caller when it arrives. Returns a version for memo deps. */
export function useMediaCatalog(): number {
  useEffect(() => {
    void loadMediaCatalog();
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

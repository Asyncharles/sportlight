import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ALL_SLOTS, type FeedState, type SlotId } from '@sportlight/shared';

/**
 * Tile lifecycle for the live stage.
 *
 * Tiles are keyed by feed, so a feed that changes window keeps its player (and playback); only its
 * position animates. A replacement mounts the incoming tile invisibly on top of the outgoing one,
 * waits for its first frame, then crossfades; the outgoing tile is removed after the fade. Nothing
 * is ever revealed before it has a picture.
 */

export type TilePhase = 'entering' | 'present' | 'leaving';

export interface StageTile {
  feed: FeedState;
  slot: SlotId;
  phase: TilePhase;
  enteredAt: number;
  /** When the tile first had a frame on screen. */
  readyAt: number | null;
  /** When the tile lost its window. */
  leftAt: number | null;
  /** When a leaving tile started fading out. */
  fadeAt: number | null;
  /** Last time the tile changed window (drives stacking during the move). */
  movedAt: number;
  /** How many times the tile has changed window (restarts the move animation). */
  moves: number;
}

/** Default reveal (crossfade) length; animated reveals pass their own. */
export const FADE_MS = 220;
/** Reveal an incoming tile anyway after this long (it shows its poster and a spinner). */
const READY_TIMEOUT_MS = 3500;
/** Never keep an outgoing tile around longer than this. */
const LEAVE_TIMEOUT_MS = 5000;
const SETTLE_MS = 40;

export function useStageTiles(assignment: Record<SlotId, FeedState | null>, revealMs = FADE_MS) {
  const [tiles, setTiles] = useState<StageTile[]>([]);
  const reveal = useRef(revealMs);
  reveal.current = revealMs;

  // Reconcile tiles with the slot assignment. The array is append-only, so React never moves
  // existing <video> elements in the DOM (moving them can pause or reset playback).
  useLayoutEffect(() => {
    const now = Date.now();
    setTiles((prev) => {
      const wanted = new Map<string, SlotId>();
      for (const slot of ALL_SLOTS) {
        const f = assignment[slot];
        if (f) wanted.set(f.id, slot);
      }
      let changed = false;
      const next = prev.map((t): StageTile => {
        const slot = wanted.get(t.feed.id);
        if (slot) {
          wanted.delete(t.feed.id);
          const feed = assignment[slot]!;
          if (slot === t.slot && t.phase !== 'leaving' && feed === t.feed) return t;
          changed = true;
          const revived = t.phase === 'leaving';
          return {
            ...t,
            feed,
            slot,
            movedAt: slot !== t.slot ? now : t.movedAt,
            moves: slot !== t.slot && !revived ? t.moves + 1 : t.moves,
            phase: revived ? (t.readyAt ? 'present' : 'entering') : t.phase,
            leftAt: revived ? null : t.leftAt,
            fadeAt: revived ? null : t.fadeAt,
          };
        }
        if (t.phase === 'leaving') return t;
        changed = true;
        return { ...t, phase: 'leaving', leftAt: now, fadeAt: null };
      });
      for (const [feedId, slot] of wanted) {
        changed = true;
        next.push({
          feed: assignment[slot]!,
          slot,
          phase: 'entering',
          enteredAt: now,
          readyAt: null,
          leftAt: null,
          fadeAt: null,
          movedAt: 0,
          moves: 0,
        });
        void feedId;
      }
      return changed ? next : prev;
    });
  }, [assignment]);

  const markReady = useCallback((feedId: string) => {
    const now = Date.now();
    setTiles((prev) =>
      prev.map((t) =>
        t.feed.id !== feedId || t.readyAt
          ? t
          : { ...t, readyAt: now, phase: t.phase === 'entering' ? 'present' : t.phase },
      ),
    );
  }, []);

  // Time-based housekeeping: reveal slow loaders, start fades, drop faded tiles.
  useEffect(() => {
    const now = Date.now();
    const FADE = reveal.current;
    let wakeAt = Infinity;
    let changed = false;
    const next: StageTile[] = [];

    for (const t of tiles) {
      if (t.phase === 'entering') {
        if (now - t.enteredAt >= READY_TIMEOUT_MS) {
          next.push({ ...t, phase: 'present', readyAt: now });
          changed = true;
        } else {
          next.push(t);
          wakeAt = Math.min(wakeAt, t.enteredAt + READY_TIMEOUT_MS);
        }
        continue;
      }
      if (t.phase === 'present') {
        next.push(t);
        continue;
      }
      // Leaving: stay fully visible until whatever replaces it has a frame up.
      if (t.fadeAt === null) {
        const successor = tiles.find((o) => o !== t && o.phase !== 'leaving' && o.slot === t.slot);
        const leftAt = t.leftAt ?? now;
        if (successor?.phase === 'present' && successor.movedAt < successor.enteredAt + 1 && successor.readyAt) {
          // A new feed is crossfading in on top: keep this one opaque underneath until the
          // crossfade completes (no dimmed midpoint), then drop it — it is fully covered.
          const coveredAt = successor.readyAt + FADE + SETTLE_MS;
          if (now >= coveredAt) {
            changed = true;
          } else {
            next.push(t);
            wakeAt = Math.min(wakeAt, coveredAt);
          }
        } else if (!successor || successor.phase === 'present' || now - leftAt >= LEAVE_TIMEOUT_MS) {
          // Window emptied, or a moving tile is growing into it: fade out.
          next.push({ ...t, fadeAt: now });
          changed = true;
        } else {
          next.push(t);
          wakeAt = Math.min(wakeAt, leftAt + LEAVE_TIMEOUT_MS);
        }
        continue;
      }
      if (now - t.fadeAt >= FADE_MS + SETTLE_MS) {
        changed = true; // faded out: drop
        continue;
      }
      next.push(t);
      wakeAt = Math.min(wakeAt, t.fadeAt + FADE_MS + SETTLE_MS);
    }

    if (changed) {
      setTiles(next);
      return;
    }
    if (wakeAt === Infinity) return;
    const timer = window.setTimeout(() => setTiles((p) => [...p]), Math.max(16, wakeAt - now));
    return () => clearTimeout(timer);
  }, [tiles]);

  return { tiles, markReady };
}

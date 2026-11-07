import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Radar } from 'lucide-react';
import { ALL_SLOTS, type FeedState, type SlotId, type VoteValue } from '@sportlight/shared';
import { FeedTile } from './FeedTile';
import type { PlaybackStatus } from './useLivePlayback';
import { useStageTiles } from './useStageTiles';
import styles from './LiveStage.module.scss';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LiveStageProps {
  assignment: Record<SlotId, FeedState | null>;
  loading: boolean;
  audioOn: boolean;
  connected: boolean;
  hotThreshold: number;
  votes: Record<string, VoteValue>;
  onVote: (feed: FeedState, value: VoteValue) => void;
  onPromote: (feedId: string) => void;
  onToggleAudio: () => void;
  onAutoplayBlocked: () => void;
  onStatus: (feedId: string, status: PlaybackStatus) => void;
}

const MOVE_STACK_MS = 400;

/**
 * Fixed four-window layout (main + three side windows). Slot placeholders define the geometry via
 * CSS grid; tiles live in an absolutely positioned layer and are placed onto the measured slot
 * rectangles, so moving a feed between windows is a transform/size transition of the same element.
 */
export function LiveStage(props: LiveStageProps) {
  const { assignment, loading } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<Partial<Record<SlotId, HTMLDivElement | null>>>({});
  const [rects, setRects] = useState<Record<SlotId, Rect> | null>(null);
  const [resizing, setResizing] = useState(true);
  const { tiles, markReady } = useStageTiles(assignment);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let settle: number | undefined;
    const measure = () => {
      const next = {} as Record<SlotId, Rect>;
      for (const slot of ALL_SLOTS) {
        const el = slotRefs.current[slot];
        if (el) next[slot] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
      }
      // Follow the window instantly while resizing; animate only selection changes.
      setResizing(true);
      setRects(next);
      clearTimeout(settle);
      settle = window.setTimeout(() => setResizing(false), 150);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => {
      ro.disconnect();
      clearTimeout(settle);
    };
  }, []);

  const occupied = new Set(tiles.filter((t) => t.phase !== 'leaving').map((t) => t.slot));
  const now = Date.now();

  return (
    <div ref={stageRef} className={`${styles.stage} ${resizing ? styles.instant : ''}`}>
      {ALL_SLOTS.map((slot) => (
        <div
          key={slot}
          ref={(el) => (slotRefs.current[slot] = el)}
          className={`${styles.slot} ${slot === 'main' ? styles.mainSlot : styles.sideSlot}`}
          aria-hidden={occupied.has(slot)}
        >
          {!occupied.has(slot) && (
            <div className={styles.placeholder}>
              {loading ? (
                <span className={styles.loadingBar} />
              ) : (
                <>
                  <Radar size={slot === 'main' ? 22 : 18} strokeWidth={1.75} />
                  <span>{slot === 'main' ? 'Waiting for the next live moment' : 'Scanning for action'}</span>
                </>
              )}
            </div>
          )}
        </div>
      ))}

      {rects &&
        tiles.map((t) => {
          const r = rects[t.slot];
          if (!r) return null;
          const moving = now - t.movedAt < MOVE_STACK_MS;
          const style: CSSProperties = {
            width: r.w,
            height: r.h,
            transform: `translate3d(${r.x}px, ${r.y}px, 0)`,
            zIndex: t.phase === 'leaving' ? 1 : moving ? 4 : t.slot === 'main' ? 3 : 2,
          };
          const visible = t.phase === 'present' || (t.phase === 'leaving' && t.fadeAt === null);
          return (
            <div
              key={t.feed.id}
              className={`${styles.layer} ${visible ? styles.visible : ''}`}
              style={style}
              aria-hidden={t.phase === 'leaving'}
              // `inert` (no focus/clicks on outgoing tiles); React 18 lacks the typing.
              {...(t.phase === 'leaving' ? ({ inert: '' } as Record<string, string>) : {})}
            >
              <FeedTile
                feed={t.feed}
                slot={t.slot}
                isMain={t.slot === 'main'}
                audioOn={props.audioOn}
                connected={props.connected}
                hotThreshold={props.hotThreshold}
                vote={props.votes[t.feed.id] ?? 0}
                onVote={props.onVote}
                onPromote={props.onPromote}
                onToggleAudio={props.onToggleAudio}
                onAutoplayBlocked={props.onAutoplayBlocked}
                onReady={markReady}
                onStatus={props.onStatus}
              />
            </div>
          );
        })}
    </div>
  );
}

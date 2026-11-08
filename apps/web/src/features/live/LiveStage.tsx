import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Radar } from 'lucide-react';
import {
  type FeedState,
  type Follow,
  type SelectionConfig,
  type SlotId,
  type UpcomingSwitch,
  type VoteValue,
} from '@sportlight/shared';
import { LogoMark } from '../../components/Logo';
import { glowFor } from '../../lib/glow';
import { layoutDef, moveMsFor, type AnyLayoutId, revealMsFor, screenNumber } from '../../lib/live-ui';
import type { SidebarSide, SwitchAnimation } from '../../lib/preferences';
import { FeedPicker } from './FeedPicker';
import { FeedTable } from './FeedTable';
import { FeedTile } from './FeedTile';
import { SwitchWarning } from './SwitchWarning';
import type { PlaybackStatus } from './useLivePlayback';
import { useStageTiles } from './useStageTiles';
import styles from './LiveStage.module.scss';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Block = SlotId | 'table';

export interface LiveStageProps {
  assignment: Record<SlotId, FeedState | null>;
  feeds: readonly FeedState[];
  follows: readonly Follow[];
  selectionConfig: SelectionConfig;
  upcoming: UpcomingSwitch[];
  layout: AnyLayoutId;
  /** Phone-sized screen: the stage fills the screen with no scrolling. */
  phone?: boolean;
  sidebar: SidebarSide;
  animation: SwitchAnimation;
  reducedMotion: boolean;
  tableExpanded: boolean;
  onTableExpanded: (expanded: boolean) => void;
  loading: boolean;
  audioOn: boolean;
  connected: boolean;
  hotThreshold: number;
  votes: Record<string, VoteValue>;
  onVote: (feed: FeedState, value: VoteValue) => void;
  onPromote: (feedId: string) => void;
  onKeep: (slot: SlotId) => void;
  /** Which windows the viewer has pinned. */
  pinned: Record<SlotId, boolean>;
  /** The header lock (every window held). */
  locked: boolean;
  onPin: (slot: SlotId, pinned: boolean) => void;
  /** Show a chosen feed in a window (and pin it). */
  onChoose: (slot: SlotId, feedId: string) => void;
  onHurry: (key: string) => void;
  onToggleAudio: () => void;
  onAutoplayBlocked: () => void;
  onStatus: (feedId: string, status: PlaybackStatus) => void;
}

/**
 * The live layout: a main window plus side windows (and, in the "Live table" layout, a table of
 * every live feed). Slot placeholders define the geometry via CSS grid; tiles live in an absolutely
 * positioned layer and are placed onto the measured slot rectangles, so moving a feed between
 * windows is a transform/size transition of the same element — its video never restarts.
 */
export function LiveStage(props: LiveStageProps) {
  const { assignment, loading, layout, sidebar, animation, reducedMotion } = props;
  const def = layoutDef(layout);
  const tableExpanded = props.tableExpanded && def.sideSlots.length > 0;
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef<Partial<Record<Block, HTMLDivElement | null>>>({});
  const [rects, setRects] = useState<Partial<Record<Block, Rect>> | null>(null);
  const [resizing, setResizing] = useState(true);
  const revealMs = revealMsFor(animation, reducedMotion);
  const moveMs = moveMsFor(animation, reducedMotion);
  const { tiles, markReady } = useStageTiles(assignment, revealMs);
  const fx = reducedMotion ? 'none' : animation;
  const [picker, setPicker] = useState<{ slot: SlotId; anchor: HTMLElement } | null>(null);
  const openPicker = useMemo(
    () => (slot: SlotId, anchor: HTMLElement) => setPicker((p) => (p?.slot === slot ? null : { slot, anchor })),
    [],
  );

  const blocks: Block[] = useMemo(
    () => ['main', ...def.sideSlots, ...(def.table ? (['table'] as const) : [])],
    [def],
  );

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let settle: number | undefined;
    const measure = () => {
      const next: Partial<Record<Block, Rect>> = {};
      for (const b of blocks) {
        const el = slotRefs.current[b];
        if (el) next[b] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
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
  }, [blocks]);

  // Keyboard: 1–4 focus that screen (then Enter → main, P → pin, C → choose feed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-4]$/.test(e.key)) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) return;
      const tile = stageRef.current?.querySelector<HTMLElement>(`[data-screen="${e.key}"]`);
      if (!tile || tile.closest('[inert]')) return;
      e.preventDefault();
      setPicker(null);
      tile.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A picker for a window that no longer shows (layout change) closes.
  useEffect(() => {
    if (picker && !blocks.includes(picker.slot)) setPicker(null);
  }, [picker, blocks]);

  // Re-render when an entry/move animation window closes, so its state class comes off.
  const now = Date.now();
  const [, setTick] = useState(0);
  useEffect(() => {
    const ends = tiles.flatMap((t) => [
      t.readyAt ? t.readyAt + revealMs + 60 : Infinity,
      t.movedAt ? t.movedAt + Math.max(moveMs, revealMs) + 60 : Infinity,
    ]);
    const next = Math.min(...ends.filter((e) => e > now));
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), next - now);
    return () => clearTimeout(timer);
  });

  const occupied = new Set(tiles.filter((t) => t.phase !== 'leaving').map((t) => t.slot));
  const coveredByTable = new Set<SlotId>(def.table && tableExpanded ? def.sideSlots : []);
  const tableRect = useMemo(() => {
    if (!rects || !def.table) return null;
    if (!tableExpanded) return rects.table ?? null;
    const parts = [...def.sideSlots, 'table' as const].map((b) => rects[b]).filter((r): r is Rect => !!r);
    if (!parts.length) return null;
    const x = Math.min(...parts.map((r) => r.x));
    const y = Math.min(...parts.map((r) => r.y));
    return {
      x,
      y,
      w: Math.max(...parts.map((r) => r.x + r.w)) - x,
      h: Math.max(...parts.map((r) => r.y + r.h)) - y,
    };
  }, [rects, def, tableExpanded]);

  const stageStyle = {
    '--fx-reveal': `${revealMs}ms`,
    '--fx-move': `${moveMs}ms`,
  } as CSSProperties;

  return (
    <div
      ref={stageRef}
      className={`${styles.stage} ${resizing ? styles.instant : ''}`}
      data-layout={layout}
      data-phone={props.phone || undefined}
      data-side={def.sided ? sidebar : undefined}
      style={stageStyle}
    >
      {blocks.map((b) => (
        <div
          key={b}
          ref={(el) => (slotRefs.current[b] = el)}
          className={styles.slot}
          data-slot={b}
          aria-hidden={b === 'table' || occupied.has(b as SlotId)}
        >
          {b !== 'table' && !occupied.has(b) && !coveredByTable.has(b) && (
            <div className={styles.placeholder}>
              {loading ? (
                <span className={styles.loadingBar} />
              ) : (
                <>
                  <span className={`${styles.screenNum} mono`} aria-hidden>
                    {screenNumber(b)}
                  </span>
                  <Radar size={b === 'main' ? 22 : 18} strokeWidth={1.75} />
                  <span>{b === 'main' ? 'Waiting for the next live moment' : 'Scanning for action'}</span>
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
          const moving = t.moves > 0 && now - t.movedAt < Math.max(moveMs, 220) + 120;
          const covered = coveredByTable.has(t.slot) && t.phase !== 'leaving';
          const successor =
            t.phase === 'leaving' && t.fadeAt === null
              ? tiles.find(
                  (o) => o !== t && o.phase === 'present' && o.slot === t.slot && o.readyAt && o.moves === 0,
                )
              : undefined;
          const entering = t.phase === 'present' && t.readyAt !== null && now - t.readyAt < revealMs + 40;
          const exiting = !!successor && now - successor.readyAt! < revealMs + 200;
          const stale = !props.connected || t.feed.intensityStale;
          const glow = covered || stale || t.phase === 'leaving' ? 0 : glowFor(t.feed.intensity?.score);
          const style = {
            width: r.w,
            height: r.h,
            transform: `translate3d(${r.x}px, ${r.y}px, 0)`,
            zIndex: t.phase === 'leaving' ? 1 : moving ? 4 : t.slot === 'main' ? 3 : 2,
            '--glow': glow.toFixed(3),
          } as CSSProperties;
          const visible = t.phase === 'present' || (t.phase === 'leaving' && t.fadeAt === null);
          const classes = [
            styles.layer,
            'sl-fx-layer',
            visible ? styles.visible : '',
            entering ? `is-entering ${styles.noFade}` : '',
            exiting ? 'is-exiting' : '',
            moving && !entering ? (t.moves % 2 ? 'is-moving-a' : 'is-moving-b') : '',
            covered ? styles.covered : '',
          ];
          const inert = t.phase === 'leaving' || covered;
          return (
            <div
              key={t.feed.id}
              className={classes.join(' ')}
              data-fx={fx}
              style={style}
              aria-hidden={inert}
              // `inert` (no focus/clicks on outgoing or covered tiles); React 18 lacks the typing.
              {...(inert ? ({ inert: '' } as Record<string, string>) : {})}
            >
              <div className={`sl-fx ${styles.fx}`}>
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
                  screen={screenNumber(t.slot)}
                  pinned={t.phase !== 'leaving' && props.pinned[t.slot]}
                  locked={props.locked}
                  onPin={props.onPin}
                  onOpenPicker={openPicker}
                />
              </div>
              <div className="sl-fx-overlay" aria-hidden>
                {fx === 'stinger' && (
                  <span className="sl-sting">
                    <LogoMark size={80} />
                  </span>
                )}
              </div>
            </div>
          );
        })}

      {tableRect && (
        <div
          className={`${styles.tableLayer} ${tableExpanded ? styles.tableExpanded : ''}`}
          style={{
            width: tableRect.w,
            height: tableRect.h,
            transform: `translate3d(${tableRect.x}px, ${tableRect.y}px, 0)`,
          }}
        >
          <FeedTable
            feeds={props.feeds}
            follows={props.follows}
            assignment={assignment}
            upcoming={props.upcoming}
            votes={props.votes}
            config={props.selectionConfig}
            connected={props.connected}
            hotThreshold={props.hotThreshold}
            expanded={tableExpanded || def.sideSlots.length === 0}
            onExpanded={def.sideSlots.length > 0 ? props.onTableExpanded : undefined}
            onPromote={props.onPromote}
          />
        </div>
      )}

      {picker && (
        <FeedPicker
          slot={picker.slot}
          anchor={picker.anchor}
          feeds={props.feeds}
          follows={props.follows}
          assignment={assignment}
          pinned={props.pinned[picker.slot]}
          onPin={props.onPin}
          onChoose={props.onChoose}
          onClose={() => setPicker(null)}
        />
      )}

      {rects &&
        props.upcoming.map((u) => {
          const r = rects[u.slot];
          const incoming = props.feeds.find((f) => f.id === u.feedId);
          if (!r || !incoming || coveredByTable.has(u.slot)) return null;
          return (
            <SwitchWarning
              key={`${u.slot}:${u.feedId}`}
              upcoming={u}
              incoming={incoming}
              compact={u.slot !== 'main' && r.w < 420}
              style={{ width: r.w, height: r.h, transform: `translate3d(${r.x}px, ${r.y}px, 0)` }}
              onKeep={() => props.onKeep(u.slot)}
              onHurry={() => props.onHurry(u.key)}
            />
          );
        })}
    </div>
  );
}

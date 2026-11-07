import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Maximize, Minimize } from 'lucide-react';
import { ALL_SLOTS, isEligible, type FeedState, type SlotId } from '@sportlight/shared';
import { glowFor } from '../../lib/glow';
import { useResolvedTheme } from '../../lib/hooks';
import { usePreferences } from '../../lib/preferences';
import { FeedTile } from './FeedTile';
import { LiveStage, type LiveStageProps } from './LiveStage';
import { SportIcon } from '../../components/SportIcon';
import { useTape } from './SpatialPanels';
import {
  createSpatialRoom,
  MONITORS,
  TILE_H,
  TILE_W,
  type MonitorId,
  type SpatialRoom,
} from './SpatialRoom';
import { SwitchTakeover } from './SpatialOverlays';
import styles from './SpatialStage.module.scss';

const noop = () => {};
const ORDER: MonitorId[] = ['main', 'side-1', 'side-2', 'side-3'];
const at = (row: number, col: number) => ORDER.find((m) => MONITORS[m].row === row && MONITORS[m].col === col)!;

/** Autopilot: minimum time on a feed, and how much hotter a rival must be to cut to it. */
const AUTO_HOLD_MS = 8000;
const AUTO_MARGIN = 6;

export default function SpatialStage(props: LiveStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<SpatialRoom | null>(null);
  const [failed, setFailed] = useState(false);
  // In portrait the whole wall is tiny: start on the first screen (Esc / tapping it again pulls back).
  const [focus, setFocusState] = useState<MonitorId | null>(() => (innerWidth < innerHeight ? 'main' : null));
  const [hovered, setHovered] = useState<MonitorId | null>(null);
  const [autopilot, setAutopilot] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const { updateLive } = usePreferences();
  const theme = useResolvedTheme();
  const { assignment, feeds, follows, hotThreshold, connected, onPromote } = props;

  const setFocus = useCallback((id: MonitorId | null, auto = false) => {
    if (!auto) setAutopilot(false);
    setFocusState(id);
  }, []);

  // ── Who is where ───────────────────────────────────────────────────────────────────────────
  const screens = useMemo(
    () =>
      ALL_SLOTS.flatMap((slot) => {
        const feed = assignment[slot];
        return feed ? [{ slot, feed, monitor: slot as MonitorId }] : [];
      }),
    [assignment],
  );
  const monitorOf = useMemo(() => new Map(screens.map((s) => [s.feed.id, s.monitor])), [screens]);
  const feedOn = (m: MonitorId | null) => (m ? (assignment[m] ?? null) : null);
  const focusedFeed = feedOn(focus);
  const eligible = useMemo(() => feeds.filter((f) => f.status === 'live' && isEligible(f, follows)), [feeds, follows]);

  // ── Room lifecycle ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!host.current || failed) return;
    let next: SpatialRoom;
    try {
      next = createSpatialRoom(host.current, props.reducedMotion, () => setFailed(true), theme);
      setRoom(next);
    } catch {
      setFailed(true);
      return;
    }
    return () => {
      next.dispose();
      setRoom(null);
    };
  }, [props.reducedMotion, failed, theme]);
  useEffect(() => room?.focus(focus), [room, focus]);
  useEffect(() => room?.setHover(focus === hovered ? null : hovered), [room, hovered, focus]);
  useEffect(() => {
    if (!room) return;
    for (const slot of ALL_SLOTS) {
      const f = assignment[slot];
      const score = f?.intensity?.score ?? null;
      const live = connected && f && !f.intensityStale;
      room.setHeat(slot as MonitorId, live ? glowFor(score) : 0, !!live && score !== null && score >= hotThreshold);
    }
  }, [room, assignment, connected, hotThreshold]);

  // ── Market data: the tape and autopilot run on the same 1 Hz beat ─────────────────────────
  const live = useRef({ focus, focusedFeed, autopilot, screens, eligible, lastCut: 0 });
  live.current = { ...live.current, focus, focusedFeed, autopilot, screens, eligible };
  const onSample = useCallback(() => {
    const s = live.current;
    const now = Date.now();
    // Autopilot: cut to the hottest screen on the desk, with hysteresis so it doesn't flicker.
    if (!s.autopilot || !s.screens.length) return;
    const best = [...s.screens].sort((a, b) => (b.feed.intensity?.score ?? 0) - (a.feed.intensity?.score ?? 0))[0]!;
    const current = s.focusedFeed?.intensity?.score ?? -Infinity;
    if (best.monitor === s.focus) return;
    if (s.focusedFeed && (now - s.lastCut < AUTO_HOLD_MS || (best.feed.intensity?.score ?? 0) < current + AUTO_MARGIN))
      return;
    live.current.lastCut = now;
    setFocusState(best.monitor);
  }, []);
  useTape(eligible, onSample);

  // ── Actions ────────────────────────────────────────────────────────────────────────────────
  /** Look at a feed: focus its monitor, or bring it onto the wall first. */
  const pick = useCallback(
    (feedId: string) => {
      const m = monitorOf.get(feedId);
      if (m) return setFocus(m);
      onPromote(feedId);
      setFocus('main');
    },
    [monitorOf, onPromote, setFocus],
  );
  const toggleAutopilot = () => {
    setAutopilot((a) => {
      if (!a) live.current.lastCut = 0;
      return !a;
    });
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void container.current?.requestFullscreen?.().catch(() => undefined);
  };
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const step = useCallback(
    (dRow: number, dCol: number) => {
      if (!focus) return setFocus('main');
      const { row, col } = MONITORS[focus];
      setFocus(at((row + dRow + 2) % 2, (col + dCol + 2) % 2));
    },
    [focus, setFocus],
  );

  // ── Keyboard ───────────────────────────────────────────────────────────────────────────────
  const keys = useRef<(e: KeyboardEvent) => void>(noop);
  keys.current = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const onTile = !!el?.closest('[role="group"]');
    const k = e.key;
    if (/^[1-4]$/.test(k)) return setFocus(ORDER[Number(k) - 1]!);
    if (k === 'Escape' && !document.fullscreenElement) return setFocus(null);
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      return step(
        k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0,
        k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0,
      );
    }
    if (onTile || el?.closest('button')) return;
    if (k.toLowerCase() === 'a') return toggleAutopilot();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Scroll in over a monitor to focus it; scroll out to pull back to the desk.
  const wheel = useRef({ sum: 0, last: 0 });
  const onWheel = (e: WheelEvent) => {
    const now = performance.now();
    if (now - wheel.current.last < 500) return;
    wheel.current.sum = Math.sign(e.deltaY) !== Math.sign(wheel.current.sum) ? e.deltaY : wheel.current.sum + e.deltaY;
    if (Math.abs(wheel.current.sum) < 60) return;
    const over = (e.target as HTMLElement).closest<HTMLElement>('[data-monitor]')?.dataset.monitor as
      MonitorId | undefined;
    if (wheel.current.sum < 0 && over && over !== focus) setFocus(over);
    else if (wheel.current.sum > 0 && focus) setFocus(null);
    else return;
    wheel.current = { sum: 0, last: now };
  };

  // Pending switches: lit up on the desk and a takeover on that screen only (no room-wide banner).
  const pending = useMemo(
    () =>
      props.upcoming.flatMap((u) => {
        const incoming = feeds.find((f) => f.id === u.feedId);
        return incoming ? [{ u, incoming }] : [];
      }),
    [props.upcoming, feeds],
  );
  useEffect(() => {
    if (!room) return;
    for (const m of ORDER)
      room.setPending(
        m,
        pending.some((p) => p.u.slot === m),
      );
  }, [room, pending]);

  if (failed)
    return (
      <div className={styles.fallback}>
        <div className={styles.notice} role="status">
          The 3D desk is unavailable on this device. Your standard view is ready.
          <button type="button" onClick={() => updateLive({ beta3d: false })}>
            Use standard view
          </button>
        </div>
        <LiveStage {...props} />
      </div>
    );

  const audibleId = props.audioOn ? (focusedFeed ?? assignment.main)?.id : undefined;
  return (
    <section
      ref={container}
      className={styles.room}
      aria-label="3D trading desk"
      data-focused={focus !== null}
      onWheel={onWheel}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        room?.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
      }}
      onPointerLeave={() => room?.setPointer(0, 0)}
    >
      <div
        className={styles.scene}
        ref={host}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-monitor]')) setFocus(null);
        }}
      />

      {room &&
        screens.map(({ feed, slot, monitor }) => (
          <Surface key={feed.id} room={room} id={feed.id} monitor={monitor}>
            <MonitorFrame
              monitor={monitor}
              focused={focus === monitor}
              onFocus={setFocus}
              onHover={setHovered}
              feed={feed}
            >
              <div
                className={styles.tileWrap}
                onClickCapture={(e) => {
                  // The picture itself never promotes here: clicking focuses, buttons act.
                  if (!(e.target as HTMLElement).closest('button')) e.stopPropagation();
                }}
              >
                <FeedTile
                  feed={feed}
                  slot={slot}
                  isMain
                  audioOn={props.audioOn}
                  audible={audibleId === feed.id}
                  connected={connected}
                  hotThreshold={hotThreshold}
                  vote={props.votes[feed.id] ?? 0}
                  onVote={props.onVote}
                  onPromote={noop}
                  onToggleAudio={props.onToggleAudio}
                  onAutoplayBlocked={props.onAutoplayBlocked}
                  onReady={noop}
                  onStatus={props.onStatus}
                  showIntensity={false}
                />
              </div>
              <Takeover {...props} slot={slot} />
            </MonitorFrame>
          </Surface>
        ))}
      {/* ── HUD ───────────────────────────────────────────────────────────────────────────── */}
      <div className={styles.top}>
        <div className={styles.bar}>
          <button
            type="button"
            aria-pressed={autopilot}
            className={autopilot ? styles.on : ''}
            onClick={toggleAutopilot}
            title="Autopilot: follow the hottest screen (A)"
          >
            <Bot size={15} /> <span>Autopilot</span>
          </button>
          <button type="button" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
            {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>
      </div>

      {props.loading && (
        <div className={styles.loading} role="status">
          Connecting to the live desk…
        </div>
      )}

      <nav className={styles.dock} aria-label="Screens">
        {ORDER.map((m) => {
          const f = feedOn(m);
          const score = f?.intensity ? Math.round(f.intensity.score) : null;
          const hot = score !== null && score >= hotThreshold && !f?.intensityStale;
          return (
            <button
              type="button"
              key={m}
              className={`${focus === m ? styles.active : ''} ${hot ? styles.hot : ''} ${hovered === m ? styles.hover : ''}`}
              aria-pressed={focus === m}
              aria-label={f ? f.event.title : 'Empty screen'}
              disabled={!f}
              onClick={() => setFocus(focus === m ? null : m)}
              onPointerEnter={() => setHovered(m)}
              onPointerLeave={() => setHovered(null)}
            >
              {f && <SportIcon sportId={f.sportId} size={13} strokeWidth={2.25} />}
              <span>{f ? f.event.title : '—'}</span>
              {f && <em>{score ?? '–'}</em>}
            </button>
          );
        })}
      </nav>
    </section>
  );
}

/** A DOM surface placed on a monitor of the 3D desk (via a portal into a CSS3D element). */
function Surface({
  room,
  id,
  monitor,
  children,
}: {
  room: SpatialRoom;
  id: string;
  monitor: MonitorId;
  children: ReactNode;
}) {
  const [element] = useState(() => {
    const el = document.createElement('div');
    el.className = styles.surface!;
    el.style.width = `${TILE_W}px`;
    el.style.height = `${TILE_H}px`;
    return el;
  });
  const current = useRef(monitor);
  current.current = monitor;
  useEffect(() => {
    room.place(id, element, current.current);
    return () => room.remove(id);
  }, [room, element, id]);
  useEffect(() => room.move(id, monitor), [room, id, monitor]);
  return createPortal(children, element);
}

/** Bezel chrome + "click to focus" layer shared by every monitor. */
function MonitorFrame({
  monitor,
  focused,
  feed,
  onFocus,
  onHover,
  children,
}: {
  monitor: MonitorId;
  focused: boolean;
  feed?: FeedState;
  onFocus: (m: MonitorId) => void;
  onHover: (m: MonitorId | null) => void;
  children: ReactNode;
}) {
  return (
    <div
      className={styles.frame}
      data-monitor={monitor}
      data-focused={focused}
      onPointerEnter={() => onHover(monitor)}
      onPointerLeave={() => onHover(null)}
    >
      {children}
      {!focused && (
        <button
          type="button"
          className={styles.hit}
          aria-label={`Focus ${feed?.event.title ?? 'screen'}`}
          onClick={(e) => {
            e.stopPropagation();
            onFocus(monitor);
          }}
        >
          <span>Focus</span>
        </button>
      )}
    </div>
  );
}

function Takeover(props: LiveStageProps & { slot: SlotId }) {
  const upcoming = props.upcoming.find((u) => u.slot === props.slot);
  const incoming = upcoming ? props.feeds.find((f) => f.id === upcoming.feedId) : undefined;
  if (!upcoming || !incoming) return null;
  return (
    <SwitchTakeover
      upcoming={upcoming}
      incoming={incoming}
      current={props.assignment[props.slot] ?? null}
      onKeep={() => props.onKeep(props.slot)}
      onHurry={() => props.onHurry(upcoming.key)}
    />
  );
}

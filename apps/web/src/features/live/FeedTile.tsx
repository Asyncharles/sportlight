import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  ArrowBigDown,
  ArrowBigUp,
  ChevronDown,
  Clock,
  Lock,
  Maximize,
  Maximize2,
  Minimize,
  Pause,
  Pin,
  PinOff,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { getSport, type FeedState, type SlotId, type VoteValue } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { TrendLine } from '../../components/TrendLine';
import { mediaUrl } from '../../lib/env';
import { useIntensityTrail, windowed } from '../../lib/intensity-trail';
import { formatDuration } from '../../lib/format';
import { BEHIND_THRESHOLD_SEC, useLivePlayback, type PlaybackStatus } from './useLivePlayback';
import styles from './FeedTile.module.scss';

export interface FeedTileProps {
  feed: FeedState;
  slot: SlotId;
  isMain: boolean;
  audioOn: boolean;
  /** Overrides who is audible (by default only the main window, when audio is on). */
  audible?: boolean;
  /** Intensity at or above this is shown as a "hot" moment. */
  hotThreshold: number;
  /** Whether live data is currently flowing (connection open). */
  connected: boolean;
  vote: VoteValue;
  onVote: (feed: FeedState, value: VoteValue) => void;
  onPromote: (feedId: string) => void;
  onToggleAudio: () => void;
  onAutoplayBlocked: () => void;
  onReady: (feedId: string) => void;
  onStatus: (feedId: string, status: PlaybackStatus) => void;
  /** Show the in-picture intensity badge (hidden in the 3D room). */
  showIntensity?: boolean;
  /** Screen number (1 = main). Shows the screen chip, pin control and feed picker when set. */
  screen?: number;
  pinned?: boolean;
  /** Every screen is held by the header lock. */
  locked?: boolean;
  onPin?: (slot: SlotId, pinned: boolean) => void;
  onOpenPicker?: (slot: SlotId, anchor: HTMLElement) => void;
}

const TOUCH_REVEAL_MS = 4000;
const ENTRY_LABEL_MS = 3500;
/** Seconds of history in the badge's trend line. */
const TREND_SEC = 45;

function FeedTileImpl(props: FeedTileProps) {
  const { feed, isMain, audioOn, connected, vote, onVote, onPromote, onToggleAudio, hotThreshold } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [showLabel, setShowLabel] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const revealTimer = useRef<number>();
  const chipRef = useRef<HTMLButtonElement>(null);
  const { screen, pinned = false, locked = false, onPin, onOpenPicker, slot } = props;
  const togglePin = () => onPin?.(slot, !pinned);
  const openPicker = () => chipRef.current && onOpenPicker?.(slot, chipRef.current);

  const { status, togglePlay, goLive, retry } = useLivePlayback(videoRef, feed, {
    muted: !(props.audible ?? (isMain && audioOn)),
    onReady: useCallback(() => props.onReady(feed.id), [props.onReady, feed.id]),
    onAutoplayBlocked: props.onAutoplayBlocked,
    onStatus: useCallback((s: PlaybackStatus) => props.onStatus(feed.id, s), [props.onStatus, feed.id]),
  });

  // Identify the feed briefly when it arrives or changes window, then get out of the way.
  useEffect(() => {
    setShowLabel(true);
    const t = window.setTimeout(() => setShowLabel(false), ENTRY_LABEL_MS);
    return () => clearTimeout(t);
  }, [props.slot, feed.runId]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === tileRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = tileRef.current;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    else v?.webkitEnterFullscreen?.(); // iOS Safari
  }, []);

  const reveal = () => {
    setRevealed(true);
    clearTimeout(revealTimer.current);
    revealTimer.current = window.setTimeout(() => setRevealed(false), TOUCH_REVEAL_MS);
  };

  const onPointerUp = (e: PointerEvent) => {
    // Touch: first tap reveals the controls (promotion is an explicit button).
    if (e.pointerType === 'touch' && !(e.target as HTMLElement).closest('button')) reveal();
  };
  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if ((e.nativeEvent as globalThis.PointerEvent).pointerType === 'touch') return;
    if (!isMain) onPromote(feed.id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    const k = e.key.toLowerCase();
    if (screen && !e.metaKey && !e.ctrlKey && !e.altKey && (k === 'p' || k === 'c')) {
      e.preventDefault();
      return k === 'p' ? togglePin() : openPicker();
    }
    if (!isMain && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onPromote(feed.id);
    } else if (isMain && e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (isMain && e.key.toLowerCase() === 'm') onToggleAudio();
    else if (isMain && e.key.toLowerCase() === 'f') toggleFullscreen();
  };

  const trail = useIntensityTrail(feed.id, feed.runId);
  const trendPoints = windowed(trail, TREND_SEC + 2);
  const sport = getSport(feed.sportId);
  const channel = feed.event.broadcaster?.channel ?? feed.event.broadcaster?.name;
  const score = feed.intensity ? Math.round(feed.intensity.score) : null;
  const stale = !connected || feed.intensityStale;
  const hot = score !== null && score >= hotThreshold && !stale;
  const behind = status.lagSec >= BEHIND_THRESHOLD_SEC && status.phase !== 'ended';
  const paused = status.phase === 'paused';
  const label = `${screen ? `Screen ${screen}${pinned ? ', pinned' : ''}: ` : ''}${feed.event.title}, ${sport?.name ?? feed.sportId}${score !== null ? `, intensity ${score}` : ''}${isMain ? ', main window' : ''}`;
  const held = pinned || locked;

  return (
    <div
      ref={tileRef}
      className={`${styles.tile} ${isMain ? styles.main : styles.side} ${revealed ? styles.revealed : ''} ${fullscreen ? styles.fullscreen : ''} ${screen ? styles.numbered : ''} ${pinned ? styles.pinned : ''}`}
      data-screen={screen}
      data-slot={slot}
      role="group"
      aria-label={label}
      tabIndex={0}
      onPointerUp={onPointerUp}
      onClick={onClick}
      onDoubleClick={isMain ? toggleFullscreen : undefined}
      onKeyDown={onKeyDown}
    >
      <video
        ref={videoRef}
        className={styles.video}
        playsInline
        loop
        preload="auto"
        muted
        poster={mediaUrl(feed.source.posterUrl)}
        disableRemotePlayback
        aria-hidden
      />

      {(status.phase === 'loading' || status.phase === 'buffering') && (
        <div className={styles.center} aria-hidden>
          <span className="sl-spinner" />
        </div>
      )}
      {status.phase === 'error' && (
        <div className={`${styles.center} ${styles.message}`}>
          <p>This feed can’t be played right now.</p>
          <button type="button" className="sl-button small secondary" onClick={retry}>
            <RotateCcw size={14} /> Retry
          </button>
        </div>
      )}
      {(feed.status !== 'live' || status.phase === 'ended') && status.phase !== 'error' && (
        <div className={styles.statusChip}>{feed.status === 'unavailable' ? 'Signal lost' : 'Ended'}</div>
      )}

      {/* Inner heat: the exponential glow from the stage, felt inside the picture too. */}
      <div className={styles.heat} aria-hidden />

      {/* Always visible: a restrained live-intensity indicator with the recent trend. */}
      {props.showIntensity !== false && (
        <>
          <div
            className={`${styles.badge} ${hot ? styles.hot : ''} ${stale ? styles.stale : ''}`}
            title={stale ? 'Intensity not updating' : `Live intensity, last ${TREND_SEC} s`}
          >
            {stale ? (
              <Clock size={12} strokeWidth={2.25} aria-label="stale" />
            ) : (
              <TrendLine points={trendPoints} seconds={TREND_SEC} width={isMain ? 40 : 30} height={14} hot={hot} />
            )}
            <span className="mono">{score ?? '–'}</span>
          </div>
        </>
      )}

      {/* Always visible: which screen this is, and whether it's held. Opens the feed picker. */}
      {screen && (
        <button
          ref={chipRef}
          type="button"
          className={`${styles.chip} ${pinned ? styles.chipPinned : ''} ${locked && !pinned ? styles.chipLocked : ''}`}
          onClick={openPicker}
          aria-haspopup="menu"
          aria-label={`Screen ${screen}${pinned ? ', pinned' : locked ? ', locked' : ''}. Choose a feed`}
          title={`Screen ${screen}${pinned ? ' · pinned' : locked ? ' · all screens locked' : ''} — press ${screen} to focus, C to change feed, P to ${pinned ? 'unpin' : 'pin'}`}
        >
          <span className="mono">{screen}</span>
          {pinned ? (
            <Pin size={12} strokeWidth={2.6} aria-hidden />
          ) : locked ? (
            <Lock size={11} strokeWidth={2.6} aria-hidden />
          ) : null}
          <ChevronDown size={12} strokeWidth={2.6} className={styles.chipCaret} aria-hidden />
        </button>
      )}

      <div className={`${styles.title} ${showLabel ? styles.titleShown : ''} ${held && screen ? styles.titleHeld : ''}`}>
        <span className={styles.titleMain}>
          <SportIcon sportId={feed.sportId} size={isMain ? 15 : 13} strokeWidth={2.25} />
          <span>{feed.event.title}</span>
        </span>
        {isMain && (feed.event.subtitle || channel) && (
          <span className={styles.subtitle}>
            {feed.event.subtitle}
            {channel && <span className={styles.channel}>{channel}</span>}
          </span>
        )}
        {!isMain && channel && <span className={styles.subtitle}>{channel}</span>}
      </div>

      {behind && (
        <button type="button" className={styles.goLive} onClick={goLive}>
          <span className={styles.liveDot} /> Go live <span className="mono">−{formatDuration(status.lagSec)}</span>
        </button>
      )}

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.ctl}
          onClick={togglePlay}
          aria-label={paused ? 'Play' : 'Pause'}
          disabled={status.phase === 'ended'}
        >
          {paused ? <Play size={18} /> : <Pause size={18} />}
        </button>
        {isMain && (
          <button
            type="button"
            className={styles.ctl}
            onClick={onToggleAudio}
            aria-label={audioOn ? 'Mute' : 'Unmute'}
            aria-pressed={audioOn}
            title={feed.source.hasAudio ? undefined : 'This feed has no audio'}
          >
            {audioOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </button>
        )}
        <span className={styles.spacer} />
        {screen && onPin && (
          <button
            type="button"
            className={`${styles.ctl} ${pinned ? styles.voted : ''}`}
            onClick={togglePin}
            aria-label={pinned ? `Unpin screen ${screen}` : `Pin screen ${screen}`}
            aria-pressed={pinned}
            title={pinned ? 'Unpin — let automatic switching change this screen (P)' : 'Pin — keep this feed on this screen (P)'}
          >
            {pinned ? <PinOff size={17} /> : <Pin size={17} />}
          </button>
        )}
        <button
          type="button"
          className={`${styles.ctl} ${vote === 1 ? styles.voted : ''}`}
          aria-label="Upvote this moment"
          aria-pressed={vote === 1}
          onClick={() => onVote(feed, vote === 1 ? 0 : 1)}
        >
          <ArrowBigUp size={19} />
        </button>
        <button
          type="button"
          className={`${styles.ctl} ${vote === -1 ? styles.votedDown : ''}`}
          aria-label="Downvote this moment"
          aria-pressed={vote === -1}
          onClick={() => onVote(feed, vote === -1 ? 0 : -1)}
        >
          <ArrowBigDown size={19} />
        </button>
        {isMain ? (
          <button
            type="button"
            className={styles.ctl}
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          >
            {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
          </button>
        ) : (
          <button
            type="button"
            className={styles.ctl}
            onClick={() => onPromote(feed.id)}
            aria-label={`Watch ${feed.event.title} in the main window`}
          >
            <Maximize2 size={17} />
          </button>
        )}
      </div>
    </div>
  );
}

export const FeedTile = memo(FeedTileImpl);

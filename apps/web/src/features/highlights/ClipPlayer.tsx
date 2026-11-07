import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Maximize, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { Highlight } from '@sportlight/shared';
import { mediaUrl } from '../../lib/env';
import { formatDuration } from '../../lib/format';
import styles from './ClipPlayer.module.scss';

export interface ClipPlayerHandle {
  /** Seconds into the clip. */
  position(): number;
}

/**
 * Replays a highlight: a [mediaStart, mediaEnd] range of the feed's media, looped. Keeps the same
 * <video> element when switching highlights of the same footage to avoid a reload.
 */
export const ClipPlayer = forwardRef<ClipPlayerHandle, { highlight: Highlight; onPosition?: (sec: number) => void }>(
  function ClipPlayer({ highlight: h, onPosition }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(true);
    const [loading, setLoading] = useState(true);
    const [pos, setPos] = useState(0);
    const { mediaStart, mediaEnd } = h.clip;
    const duration = mediaEnd - mediaStart;

    useImperativeHandle(ref, () => ({ position: () => (videoRef.current?.currentTime ?? mediaStart) - mediaStart }), [
      mediaStart,
    ]);

    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      setLoading(true);
      const begin = () => {
        v.currentTime = mediaStart;
        v.play().catch(() => setPlaying(false));
      };
      if (v.readyState >= 1) begin();
      else v.addEventListener('loadedmetadata', begin, { once: true });
      return () => v.removeEventListener('loadedmetadata', begin);
    }, [h.id, mediaStart]);

    // Loop within the clip and publish the playhead.
    useEffect(() => {
      let raf = 0;
      let last = -1;
      const tick = () => {
        const v = videoRef.current;
        if (v) {
          if (v.currentTime >= mediaEnd - 0.04 || v.currentTime < mediaStart - 0.5) v.currentTime = mediaStart;
          const p = Math.max(0, Math.min(duration, v.currentTime - mediaStart));
          if (Math.abs(p - last) >= 0.05) {
            last = p;
            setPos(p);
            onPosition?.(p);
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      // rAF pauses in background tabs; `timeupdate` keeps the loop bounded regardless.
      const v = videoRef.current;
      const bound = () => {
        if (v && (v.currentTime >= mediaEnd - 0.04 || v.currentTime < mediaStart - 0.5)) v.currentTime = mediaStart;
      };
      v?.addEventListener('timeupdate', bound);
      return () => {
        cancelAnimationFrame(raf);
        v?.removeEventListener('timeupdate', bound);
      };
    }, [mediaStart, mediaEnd, duration, onPosition]);

    const toggle = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) void v.play();
      else v.pause();
    }, []);

    const restart = () => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = mediaStart;
      void v.play();
    };

    const seek = (fraction: number) => {
      const v = videoRef.current;
      if (v) v.currentTime = mediaStart + fraction * duration;
    };

    const fullscreen = () => {
      const el = wrapRef.current;
      if (document.fullscreenElement) void document.exitFullscreen();
      else void el?.requestFullscreen?.().catch(() => undefined);
    };

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if ((e.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
        if (e.key === ' ' || e.key === 'k') {
          e.preventDefault();
          toggle();
        } else if (e.key === 'm') setMuted((m) => !m);
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [toggle]);

    return (
      <div ref={wrapRef} className={styles.player}>
        <video
          ref={videoRef}
          className={styles.video}
          src={mediaUrl(h.source.url)}
          poster={mediaUrl(h.thumbnailUrl)}
          muted={muted}
          playsInline
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onPlaying={() => setLoading(false)}
          onWaiting={() => setLoading(true)}
          onClick={toggle}
        />
        {loading && (
          <div className={styles.center} aria-hidden>
            <span className="sl-spinner" />
          </div>
        )}
        <div className={styles.controls}>
          <button type="button" className={styles.ctl} onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" className={styles.ctl} onClick={restart} aria-label="Replay from start">
            <RotateCcw size={17} />
          </button>
          <button
            type="button"
            className={styles.ctl}
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? 'Unmute' : 'Mute'}
            aria-pressed={!muted}
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            className={styles.scrub}
            type="range"
            min={0}
            max={1000}
            value={duration > 0 ? Math.round((pos / duration) * 1000) : 0}
            onChange={(e) => seek(Number(e.target.value) / 1000)}
            aria-label="Position in clip"
            style={{ ['--p' as string]: `${duration > 0 ? (pos / duration) * 100 : 0}%` }}
          />
          <span className={`${styles.time} mono`}>
            {formatDuration(pos)} / {formatDuration(duration)}
          </span>
          <button type="button" className={styles.ctl} onClick={fullscreen} aria-label="Full screen">
            <Maximize size={17} />
          </button>
        </div>
      </div>
    );
  },
);

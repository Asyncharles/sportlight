import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { liveMediaTime, loopDelta, mod, type FeedState } from '@sportlight/shared';
import { mediaUrl } from '../../lib/env';
import { attachHls, type HlsHandle } from '../../lib/hls-playback';
import { live } from '../../lib/live-client';
import { hlsFor, mediaCatalogReady } from '../../lib/media-catalog';

export type PlaybackPhase = 'loading' | 'playing' | 'paused' | 'buffering' | 'error' | 'ended';

export interface PlaybackStatus {
  phase: PlaybackPhase;
  /** Seconds behind the live edge. */
  lagSec: number;
}

interface Options {
  muted: boolean;
  /** First frame at the live position is on screen. */
  onReady?: () => void;
  /** The browser refused unmuted playback. */
  onAutoplayBlocked?: () => void;
  onStatus?: (s: PlaybackStatus) => void;
}

const SYNC_MS = 1000;
const HARD_SEEK_SEC = 2.5;
const BUFFERING_DELAY_MS = 350;
const MAX_RETRIES = 4;
/** How long a tile waits for the media catalog (which says whether there's an HLS copy). */
const CATALOG_WAIT_MS = 1500;
/** Show "Go live" once playback is this far behind. */
export const BEHIND_THRESHOLD_SEC = 2;

/**
 * Simulated-live playback for a looping MP4.
 *
 * The live position is derived from the run start and the server clock, so every viewer sees the
 * same moment. The player follows `live − lag`: pausing grows `lag`, "Go live" resets it. Small
 * drift is tolerated to preserve normal speed; large drift (stalls, background
 * tabs) by seeking. The <video> element is never recreated for a feed, which is what lets the
 * stage move a tile between windows without restarting playback.
 */
export function useLivePlayback(videoRef: RefObject<HTMLVideoElement>, feed: FeedState, opts: Options) {
  const [status, setStatus] = useState<PlaybackStatus>({ phase: 'loading', lagSec: 0 });
  const feedRef = useRef(feed);
  feedRef.current = feed;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const lagRef = useRef(0); // accumulated lag, excluding an ongoing pause
  const pausedAtRef = useRef<number | null>(null);
  const readyRef = useRef(false);
  const phaseRef = useRef<PlaybackPhase>('loading');
  const retriesRef = useRef(0);
  const bufferTimer = useRef<number>();
  const [attempt, setAttempt] = useState(0);

  const setPhase = useCallback((phase: PlaybackPhase) => {
    phaseRef.current = phase;
    setStatus((s) => (s.phase === phase ? s : { ...s, phase }));
  }, []);

  const currentLag = () =>
    lagRef.current + (pausedAtRef.current === null ? 0 : (Date.now() - pausedAtRef.current) / 1000);

  const targetTime = useCallback(() => {
    const f = feedRef.current;
    return mod(liveMediaTime(f, live.serverNow()) - lagRef.current, f.source.durationSec);
  }, []);

  const play = useCallback((v: HTMLVideoElement) => {
    v.play().catch((err: DOMException) => {
      if (err.name === 'NotAllowedError' && !v.muted) {
        v.muted = true; // policy: fall back to muted rather than not playing at all
        optsRef.current.onAutoplayBlocked?.();
        v.play().catch(() => undefined);
      }
    });
  }, []);

  const src = mediaUrl(feed.source.url);

  // Load the source; (re)establish the live position. The HLS copy when there is one (segments, and
  // a small rendition for small tiles), else the MP4 itself.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;
    readyRef.current = false;
    retriesRef.current = 0;
    setPhase('loading');
    v.muted = optsRef.current.muted;
    let cancelled = false;
    let hls: HlsHandle | null = null;

    const loadMp4 = () => {
      hls?.destroy();
      hls = null;
      v.src = src;
      v.load();
    };
    const start = async () => {
      await mediaCatalogReady(CATALOG_WAIT_MS);
      const hlsUrl = cancelled ? undefined : hlsFor(src);
      if (cancelled) return;
      if (!hlsUrl) return loadMp4();
      try {
        const handle = await attachHls(v, hlsUrl, targetTime(), () => {
          if (cancelled || !hls) return;
          hls = null; // already destroyed; the MP4 has the same timeline
          loadMp4();
        });
        if (cancelled) return handle?.destroy();
        if (!handle) return loadMp4();
        hls = handle;
      } catch {
        if (!cancelled) loadMp4(); // hls.js chunk failed to load
      }
    };

    const markReady = () => {
      if (readyRef.current) return;
      readyRef.current = true;
      // Wait until a frame at the new position is actually composited: no blank or stale frame
      // is ever revealed by a crossfade.
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(() => optsRef.current.onReady?.());
      else optsRef.current.onReady?.();
    };
    const onMeta = () => {
      v.currentTime = targetTime();
      if (pausedAtRef.current === null && feedRef.current.status !== 'ended') play(v);
    };
    const onSeeked = () => {
      if (pausedAtRef.current !== null) markReady(); // paused but positioned
    };
    const onPlaying = () => {
      clearTimeout(bufferTimer.current);
      retriesRef.current = 0;
      setPhase(pausedAtRef.current === null ? 'playing' : 'paused');
      markReady();
    };
    const onWaiting = () => {
      clearTimeout(bufferTimer.current);
      bufferTimer.current = window.setTimeout(() => {
        if (readyRef.current && phaseRef.current === 'playing') setPhase('buffering');
      }, BUFFERING_DELAY_MS);
    };
    const onError = () => {
      if (hls?.managed) return; // hls.js retries, then falls back to the MP4 itself
      if (hls) return loadMp4(); // native HLS failed: same timeline in the MP4
      if (retriesRef.current >= MAX_RETRIES) {
        setPhase('error');
        optsRef.current.onReady?.(); // reveal the tile so the error is visible
        return;
      }
      const delay = 1000 * 2 ** retriesRef.current++;
      window.setTimeout(() => {
        if (videoRef.current !== v) return;
        v.src = src;
        v.load();
      }, delay);
    };

    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onWaiting);
    v.addEventListener('error', onError);
    void start();
    return () => {
      cancelled = true;
      hls?.destroy();
      clearTimeout(bufferTimer.current);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('stalled', onWaiting);
      v.removeEventListener('error', onError);
    };
  }, [src, attempt, videoRef, targetTime, play, setPhase]);

  // A new run of the same feed starts at the live edge.
  useEffect(() => {
    lagRef.current = 0;
    pausedAtRef.current = null;
  }, [feed.runId]);

  // Audio follows the window (only the main window may be unmuted).
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = opts.muted;
  }, [opts.muted, videoRef]);

  // Ended feeds freeze on their last frame.
  useEffect(() => {
    const v = videoRef.current;
    if (feed.status === 'ended' && v) {
      v.pause();
      setPhase('ended');
    }
  }, [feed.status, videoRef, setPhase]);

  // Drift correction + lag reporting.
  useEffect(() => {
    const sync = () => {
      const v = videoRef.current;
      if (!v) return;
      const lagSec = Math.round(currentLag() * 10) / 10;
      setStatus((s) => (Math.abs(s.lagSec - lagSec) < 0.05 ? s : { ...s, lagSec }));
      if (!readyRef.current || pausedAtRef.current !== null || v.seeking || phaseRef.current === 'ended') return;
      if (phaseRef.current === 'error') return;

      const duration = feedRef.current.source.durationSec;
      const target = targetTime();
      const drift = loopDelta(v.currentTime, target, duration);
      if (Math.abs(drift) > HARD_SEEK_SEC) {
        v.playbackRate = 1;
        v.currentTime = target;
      } else if (v.playbackRate !== 1) {
        v.playbackRate = 1;
      }
      if (v.paused) play(v); // e.g. paused by the browser while backgrounded
    };
    const timer = window.setInterval(sync, SYNC_MS);
    const onVisible = () => document.visibilityState === 'visible' && sync();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [videoRef, targetTime, play]);

  useEffect(() => {
    optsRef.current.onStatus?.(status);
  }, [status]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || phaseRef.current === 'ended') return;
    if (pausedAtRef.current === null) {
      pausedAtRef.current = Date.now();
      v.pause();
      setPhase('paused');
    } else {
      lagRef.current += (Date.now() - pausedAtRef.current) / 1000;
      pausedAtRef.current = null;
      play(v);
      setPhase('playing');
    }
    setStatus((s) => ({ ...s, lagSec: Math.round(currentLag() * 10) / 10 }));
  }, [videoRef, play, setPhase]);

  const goLive = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    lagRef.current = 0;
    pausedAtRef.current = null;
    v.playbackRate = 1;
    v.currentTime = targetTime();
    play(v);
    setPhase('playing');
    setStatus((s) => ({ ...s, lagSec: 0 }));
  }, [videoRef, targetTime, play, setPhase]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { status, togglePlay, goLive, retry };
}

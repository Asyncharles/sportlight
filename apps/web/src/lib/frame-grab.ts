import { useEffect, useState } from 'react';
import type { Highlight } from '@sportlight/shared';
import { apiUrl, mediaUrl } from './env';

/**
 * Stills for clips whose source has no thumbnail strip (e.g. feeds announced by the engine): seek a
 * detached <video> to the moment and copy that frame to a small JPEG. Grabs run a couple at a time so
 * a grid of tiles doesn't open dozens of media connections, and results are cached per URL + second.
 */

const MAX_CONCURRENT = 3;
const MAX_WIDTH = 640;
const TIMEOUT_MS = 20_000;

const cache = new Map<string, Promise<string | undefined>>();
const queue: Array<() => void> = [];
let running = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

/** Object URL of the frame at `timeSec`, or undefined when it can't be read (network, CORS). */
export function grabFrame(url: string, timeSec: number): Promise<string | undefined> {
  const key = `${url}#${Math.round(timeSec)}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = schedule(() => capture(url, timeSec)).catch(() => undefined);
    cache.set(key, hit);
  }
  return hit;
}

/** A grab that already finished, so a component can render it on its first paint. */
const settled = new Map<string, string | undefined>();
export function cachedFrame(url: string, timeSec: number): string | undefined {
  return settled.get(`${url}#${Math.round(timeSec)}`);
}

function capture(url: string, timeSec: number): Promise<string | undefined> {
  const key = `${url}#${Math.round(timeSec)}`;
  return new Promise<string | undefined>((resolve) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    let done = false;
    const finish = (result: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settled.set(key, result);
      v.removeAttribute('src');
      v.load(); // release the connection
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(undefined), TIMEOUT_MS);
    v.addEventListener('error', () => finish(undefined));
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = Math.min(Math.max(0, timeSec), Math.max(0, v.duration - 0.1));
    });
    v.addEventListener('seeked', () => {
      try {
        const scale = Math.min(1, MAX_WIDTH / (v.videoWidth || MAX_WIDTH));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round((v.videoWidth || MAX_WIDTH) * scale);
        canvas.height = Math.round((v.videoHeight || MAX_WIDTH * 0.5625) * scale);
        canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => finish(blob ? URL.createObjectURL(blob) : undefined), 'image/jpeg', 0.8);
      } catch {
        finish(undefined); // tainted canvas: media origin without CORS
      }
    });
    v.src = url;
  });
}

/** Media second of a highlight's peak, within its replay range. */
export function peakMediaTime(h: Highlight): number {
  const t = h.clip.mediaStart + (h.peak.streamTime - h.clip.streamStart);
  return Math.min(h.clip.mediaEnd, Math.max(h.clip.mediaStart, t));
}

/**
 * The image to show for a highlight: its thumbnail; else (missing / failed to load) a still the
 * backend renders once and the browser caches; else, last resort, a frame grabbed here once `enabled`
 * (e.g. the tile is near the viewport). `ready` flips when the image has actually decoded, so callers
 * can keep a skeleton up until then.
 */
export function useHighlightStill(h: Highlight, enabled = true) {
  const thumb = mediaUrl(h.thumbnailUrl);
  const video = mediaUrl(h.source.url);
  const at = peakMediaTime(h);
  const server = apiUrl(`/api/highlights/${h.id}/still.jpg?t=${Math.round(at)}`);
  const grabKey = video ? `${video}#${Math.round(at)}` : '';
  // Each piece of state remembers which URL it belongs to, so a new highlight starts clean.
  const [failedThumb, setFailedThumb] = useState<string>();
  const [failedServer, setFailedServer] = useState<string>();
  const [grab, setGrab] = useState<{ key: string; src?: string }>();
  const [loadedSrc, setLoadedSrc] = useState<string>();
  const thumbOk = Boolean(thumb) && failedThumb !== thumb;
  const serverOk = !thumbOk && failedServer !== server;
  const needsGrab = !thumbOk && !serverOk;
  const cached = video ? cachedFrame(video, at) : undefined;
  const grabbed = cached ?? (grab?.key === grabKey ? grab.src : undefined);
  const grabSettled = cached !== undefined || grab?.key === grabKey;

  useEffect(() => {
    if (!needsGrab || !enabled || !video || grabSettled) return;
    let live = true;
    void grabFrame(video, at).then((src) => {
      if (live) setGrab({ key: grabKey, src });
    });
    return () => {
      live = false;
    };
  }, [needsGrab, enabled, video, at, grabKey, grabSettled]);

  // The server still waits for `enabled` too, so off-screen tiles don't queue renders.
  const src = thumbOk ? thumb : serverOk ? (enabled || loadedSrc === server ? server : undefined) : grabbed;
  return {
    src,
    ready: Boolean(src) && loadedSrc === src,
    /** Nothing left to try: show the plain fallback instead of a skeleton. */
    failed: needsGrab && !grabbed && (grabSettled || !video),
    onLoad: () => setLoadedSrc(src),
    onError: () => {
      if (thumbOk) setFailedThumb(thumb);
      else if (serverOk) setFailedServer(server);
      else setGrab({ key: grabKey, src: undefined });
    },
  };
}

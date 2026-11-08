/**
 * HLS for the live screen. Each feed's MP4 has an HLS copy (see media/import-local.mjs): the source
 * video in ~5 s segments, plus a 360p rendition. hls.js plays it where Media Source Extensions exist
 * and, with capLevelToPlayerSize, small tiles stay on 360p while the main window gets the source.
 * Safari without MSE plays the playlist natively. hls.js is loaded on first use, not in the main bundle.
 */

export interface HlsHandle {
  destroy(): void;
  /** hls.js handles errors itself (retries, then onFatal); native playback reports them on <video>. */
  managed: boolean;
}

const MPEGURL = 'application/vnd.apple.mpegurl';

/**
 * Plays `url` in `v`, starting at `startSec`. Resolves to null when this browser can't play HLS (the
 * caller uses the MP4 instead). `onFatal` fires if HLS fails after starting, for the same fallback.
 */
export async function attachHls(
  v: HTMLVideoElement,
  url: string,
  startSec: number,
  onFatal: () => void,
): Promise<HlsHandle | null> {
  const { default: Hls } = await import('hls.js/light'); // no subtitles, alt audio or DRM: not needed
  if (!Hls.isSupported()) {
    if (!v.canPlayType(MPEGURL)) return null;
    v.src = url;
    v.load();
    return { destroy: () => undefined, managed: false };
  }
  const hls = new Hls({
    capLevelToPlayerSize: true,
    // Size by CSS pixels: on a 2x screen a 325px side tile would otherwise count as 650px and take
    // the source rendition, which is what this is meant to avoid.
    ignoreDevicePixelRatio: true,
    startLevel: -1, // pick by bandwidth estimate: small tiles start on 360p instead of the source
    startPosition: startSec,
    maxBufferLength: 20,
    maxMaxBufferLength: 40,
    backBufferLength: 10,
  });
  let recoveredMedia = false;
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
      recoveredMedia = true;
      hls.recoverMediaError();
      return;
    }
    hls.destroy();
    onFatal();
  });
  hls.loadSource(url);
  hls.attachMedia(v);
  return { destroy: () => hls.destroy(), managed: true };
}

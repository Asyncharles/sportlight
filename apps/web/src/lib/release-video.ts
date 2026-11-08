import { useEffect, type RefObject } from 'react';

/**
 * Stops a <video>'s download and drops its buffer. A video removed from the page with its src still
 * set keeps its connection and keeps buffering until it is garbage collected; the feeds are
 * 300–700 MB files, so a few of those (one per feed switch or hover preview) starve the players that
 * are actually on screen, and over HTTP/1.1 they hold all six connections the browser allows per host.
 */
export function releaseVideo(v: Pick<HTMLVideoElement, 'pause' | 'removeAttribute' | 'load'>) {
  v.pause();
  v.removeAttribute('src');
  v.load(); // with no src: aborts the fetch and empties the element
}

/**
 * Releases the video in `ref` once it leaves the page: when the component unmounts, or when `mounted`
 * (the condition the <video> is rendered under, if any) turns false. It deliberately does not run when
 * `src` changes: React sets a new src itself, and releasing then would drop it.
 */
export function useReleaseVideo(ref: RefObject<HTMLVideoElement>, mounted = true) {
  useEffect(() => {
    const v = ref.current; // React has already cleared the ref by the time an unmount cleanup runs
    if (!mounted || !v) return;
    return () => releaseVideo(v);
  }, [ref, mounted]);
}

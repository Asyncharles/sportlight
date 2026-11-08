import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Highlight, HighlightTier } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { mediaUrl } from '../../lib/env';
import { useHighlightStill } from '../../lib/frame-grab';
import { highlightTitle, showsEventSeparately } from '../../lib/highlights';
import { formatDuration, formatTimeOfDay } from '../../lib/format';
import { useMediaQuery, useNearViewport, useReducedMotion } from '../../lib/hooks';
import styles from './HighlightTile.module.scss';

const PREVIEW_DELAY_MS = 280;

/** Thumbnail tile; on hover (pointer devices) it previews the clip muted. */
export function HighlightTile({
  highlight: h,
  tier,
  timezone,
}: {
  highlight: Highlight;
  tier: HighlightTier;
  timezone?: string;
}) {
  const canHover = useMediaQuery('(hover: hover)');
  const reduced = useReducedMotion();
  const [preview, setPreview] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<number>();
  const tileRef = useRef<HTMLAnchorElement>(null);
  const nearView = useNearViewport(tileRef);
  const still = useHighlightStill(h, nearView);

  const start = () => {
    if (!canHover || reduced) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPreview(true), PREVIEW_DELAY_MS);
  };
  const stop = () => {
    clearTimeout(timer.current);
    setPreview(false);
    setPreviewing(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Link
      ref={tileRef}
      to={`/best/${h.id}`}
      className={`${styles.tile} ${styles[tier]} ${still.ready || still.failed ? '' : 'sl-skeleton'}`}
      data-loaded={still.ready || undefined}
      onPointerEnter={start}
      onPointerLeave={stop}
      onFocus={start}
      onBlur={stop}
      aria-label={`${highlightTitle(h)}, ${h.event.title}, peak intensity ${Math.round(h.peak.score)}, ${formatDuration(h.clip.durationSec)} at ${formatTimeOfDay(h.peak.at, timezone)}`}
    >
      {still.failed && <span className={styles.fallback} aria-hidden><SportIcon sportId={h.sportId} size={tier === 'large' ? 56 : 32} strokeWidth={1.25} /></span>}
      {still.src && (
        <img
          key={still.src}
          className={`${styles.thumb} ${still.ready ? styles.thumbShown : ''}`}
          src={still.src}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={still.onLoad}
          onError={still.onError}
          ref={(img) => {
            if (img?.complete && img.naturalWidth > 0 && !still.ready) still.onLoad();
          }}
        />
      )}
      {preview && <PreviewVideo highlight={h} onShown={() => setPreviewing(true)} />}
      {preview && !previewing && <span className={styles.buffering} aria-hidden />}
      <span className={styles.peak}>
        <span className="mono">{Math.round(h.peak.score)}</span>
      </span>
      <span className={styles.meta}>
        <span className={styles.title}>
          <SportIcon sportId={h.sportId} size={tier === 'small' ? 12 : 14} strokeWidth={2.25} />
          <span>{highlightTitle(h)}</span>
        </span>
        {tier !== 'small' && h.caption?.description && <span className={styles.desc}>{h.caption.description}</span>}
        <span className={styles.detail}>
          {showsEventSeparately(h) && <span className={styles.event}>{h.event.title}</span>}
          <span className="mono">{formatTimeOfDay(h.peak.at, timezone)}</span>
          <span className="mono">{formatDuration(h.clip.durationSec)}</span>
        </span>
      </span>
    </Link>
  );
}

function PreviewVideo({ highlight: h, onShown }: { highlight: Highlight; onShown: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onMeta = () => {
      v.currentTime = h.clip.mediaStart;
      v.play().catch(() => undefined);
    };
    const onTime = () => {
      if (v.currentTime >= h.clip.mediaEnd) v.currentTime = h.clip.mediaStart;
    };
    const onPlaying = () => {
      setShown(true);
      onShown();
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('playing', onPlaying);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('playing', onPlaying);
    };
  }, [h.clip.mediaStart, h.clip.mediaEnd]);
  return (
    <video
      ref={ref}
      className={`${styles.preview} ${shown ? styles.previewShown : ''}`}
      src={mediaUrl(h.source.url)}
      muted
      playsInline
      preload="auto"
      aria-hidden
    />
  );
}

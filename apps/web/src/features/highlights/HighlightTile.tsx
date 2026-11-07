import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Highlight, HighlightTier } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { mediaUrl } from '../../lib/env';
import { highlightTitle, showsEventSeparately } from '../../lib/highlights';
import { formatDuration, formatTimeOfDay } from '../../lib/format';
import { useMediaQuery, useReducedMotion } from '../../lib/hooks';
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
  const timer = useRef<number>();

  const start = () => {
    if (!canHover || reduced) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPreview(true), PREVIEW_DELAY_MS);
  };
  const stop = () => {
    clearTimeout(timer.current);
    setPreview(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Link
      to={`/best/${h.id}`}
      className={`${styles.tile} ${styles[tier]}`}
      onPointerEnter={start}
      onPointerLeave={stop}
      onFocus={start}
      onBlur={stop}
      aria-label={`${highlightTitle(h)}, ${h.event.title}, peak intensity ${Math.round(h.peak.score)}, ${formatDuration(h.clip.durationSec)} at ${formatTimeOfDay(h.peak.at, timezone)}`}
    >
      {h.thumbnailUrl && (
        <img className={styles.thumb} src={mediaUrl(h.thumbnailUrl)} alt="" loading="lazy" decoding="async" />
      )}
      {preview && <PreviewVideo highlight={h} />}
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

function PreviewVideo({ highlight: h }: { highlight: Highlight }) {
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
    const onPlaying = () => setShown(true);
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

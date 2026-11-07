import { useId } from 'react';
import type { Highlight } from '@sportlight/shared';
import styles from './IntensityCurve.module.scss';

/**
 * Intensity across the clip, with the highlight threshold and the playhead. Purely informative —
 * a single series, so no legend; values are announced via the summary label.
 */
export function IntensityCurve({
  highlight: h,
  position,
  threshold,
}: {
  highlight: Highlight;
  position: number;
  threshold: number;
}) {
  const id = useId();
  const W = 600;
  const H = 72;
  const duration = Math.max(0.1, h.clip.mediaEnd - h.clip.mediaStart);
  const pts = h.curve.length ? h.curve : [[0, h.peak.score] as [number, number]];
  const x = (t: number) => (Math.max(0, Math.min(duration, t)) / duration) * W;
  const y = (v: number) => H - 4 - (v / 100) * (H - 8);
  const line = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts[pts.length - 1]![0]).toFixed(1)},${H} L${x(pts[0]![0]).toFixed(1)},${H} Z`;
  const peakT = h.peak.streamTime - h.clip.streamStart;

  return (
    <figure className={styles.wrap} aria-label={`Intensity over the clip, peaking at ${Math.round(h.peak.score)}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={styles.svg} role="img" aria-hidden>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--sl-lime)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--sl-lime)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1="0"
          x2={W}
          y1={y(threshold)}
          y2={y(threshold)}
          className={styles.threshold}
          vectorEffect="non-scaling-stroke"
        />
        <path d={area} fill={`url(#${id}-fill)`} />
        <path d={line} className={styles.line} vectorEffect="non-scaling-stroke" />
        <line
          x1={x(position)}
          x2={x(position)}
          y1="0"
          y2={H}
          className={styles.playhead}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className={styles.peak}
        style={{ left: `${(x(peakT) / W) * 100}%`, top: `${(y(h.peak.score) / H) * 100}%` }}
        aria-hidden
      />
    </figure>
  );
}

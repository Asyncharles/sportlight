import { memo, useId } from 'react';
import type { TrailPoint } from '../lib/intensity-trail';

/**
 * A tiny intensity trend (0–100 scale) with a soft fill and an end dot. Time is the x axis over the
 * last `seconds`, so the line scrolls rather than rescales as new readings arrive.
 */
function TrendLineImpl({
  points,
  seconds,
  width,
  height,
  hot = false,
  className,
  label,
}: {
  points: TrailPoint[];
  seconds: number;
  width: number;
  height: number;
  hot?: boolean;
  className?: string;
  label?: string;
}) {
  const id = `trend${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (points.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line x1={0} x2={width} y1={height - 1.5} y2={height - 1.5} stroke="currentColor" strokeOpacity={0.25} strokeDasharray="2 3" />
      </svg>
    );
  }
  const end = points[points.length - 1]![0];
  const start = end - seconds;
  const pad = 1.5;
  const x = (t: number) => Math.max(0, ((t - start) / seconds) * (width - pad * 2)) + pad;
  // Spread the lower half: the interesting range is 30–100.
  const y = (v: number) => {
    const n = Math.max(0, Math.min(1, (v - 20) / 80));
    return height - pad - n * (height - pad * 2);
  };
  const visible = points.filter(([t]) => t >= start - 2);
  const d = visible.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const first = visible[0]!;
  const last = visible[visible.length - 1]!;
  const area = `${d} L${x(last[0]).toFixed(1)},${height} L${x(first[0]).toFixed(1)},${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity={hot ? 0.45 : 0.28} />
          <stop offset="1" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} stroke="none" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r={1.8} fill="currentColor" />
    </svg>
  );
}

export const TrendLine = memo(TrendLineImpl);

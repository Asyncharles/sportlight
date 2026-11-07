/** Tiny inline intensity trace (0–100) for the admin table. */
export function Sparkline({
  points,
  width = 120,
  height = 26,
}: {
  points: Array<[number, number]>;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const t0 = points[0]![0];
  const span = Math.max(1, points[points.length - 1]![0] - t0);
  const d = points
    .map(
      ([t, v], i) =>
        `${i ? 'L' : 'M'}${(((t - t0) / span) * width).toFixed(1)},${(height - 2 - (v / 100) * (height - 4)).toFixed(1)}`,
    )
    .join(' ');
  const last = points[points.length - 1]![1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`Intensity trend, now ${Math.round(last)}`}
      role="img"
    >
      <path d={d} fill="none" stroke="var(--accent-text)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

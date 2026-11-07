/**
 * Glow strength (0–1) for an intensity score. Exponential: barely there in the 70s, unmistakable
 * in the 90s, so only genuinely big moments light up.
 *
 *   g(s) = (e^(k·t) − 1) / (e^k − 1),  t = (s − from) / (100 − from)
 *
 * With from = 65 and k = 4.5: 70 → 0.01, 80 → 0.06, 90 → 0.24, 95 → 0.46, 100 → 1.
 */
export function glowFor(score: number | null | undefined, from = 65, k = 4.5): number {
  if (score == null || score <= from) return 0;
  const t = Math.min(1, (score - from) / (100 - from));
  return (Math.exp(k * t) - 1) / (Math.exp(k) - 1);
}

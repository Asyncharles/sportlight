/**
 * Caps how many feeds are live at once. Feeds whose schedule says they should be live compete for
 * `max` slots; when others are waiting, a feed that has been on air for `rotateMs` hands its slot
 * over, so the whole catalog still gets airtime. Waiting feeds that aired least recently go first.
 */
export interface LivePlanInput {
  /** Feed ids that the schedule says should be live now, in priority order. */
  wanted: string[];
  /** Running feed id → run start (ms). */
  running: Map<string, number>;
  /** Feed id → when its last run ended (ms). */
  lastEndedMs: Map<string, number>;
  now: number;
  /** Maximum concurrent live feeds; 0 or less means unlimited. */
  max: number;
  rotateMs: number;
}

export function planLive({ wanted, running, lastEndedMs, now, max, rotateMs }: LivePlanInput) {
  const wantedSet = new Set(wanted);
  const stop = [...running.keys()].filter((id) => !wantedSet.has(id));
  const keep = [...running.entries()].filter(([id]) => wantedSet.has(id)).sort((a, b) => a[1] - b[1]);
  const waiting = wanted
    .filter((id) => !running.has(id))
    .map((id, order) => ({ id, order, last: lastEndedMs.get(id) ?? -Infinity }))
    .sort((a, b) => a.last - b.last || a.order - b.order)
    .map((w) => w.id);
  if (max <= 0) return { start: waiting, stop };

  // Over the cap (e.g. the limit was lowered): end the longest-running feeds first.
  while (keep.length > max) stop.push(keep.shift()![0]);
  let free = max - keep.length;
  for (const [id, startedAt] of keep) {
    if (waiting.length <= free) break;
    if (now - startedAt < rotateMs) break; // sorted oldest first
    stop.push(id);
    free++;
  }
  return { start: waiting.slice(0, free), stop };
}

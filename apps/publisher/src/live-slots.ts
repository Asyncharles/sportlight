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
  /** Feeds that are always live when wanted. They take slots first and are never rotated out. */
  pinned?: ReadonlySet<string>;
}

export function planLive(input: LivePlanInput): { start: string[]; stop: string[] } {
  const pinned = input.pinned;
  if (!pinned?.size) return planRotating(input);
  const { wanted, running, max } = input;
  const pinnedWanted = wanted.filter((id) => pinned.has(id));
  const start = pinnedWanted.filter((id) => !running.has(id));
  const stop = [...running.keys()].filter((id) => pinned.has(id) && !pinnedWanted.includes(id));
  const others = {
    ...input,
    wanted: wanted.filter((id) => !pinned.has(id)),
    running: new Map([...running].filter(([id]) => !pinned.has(id))),
  };
  if (max > 0 && max - pinnedWanted.length <= 0) {
    // Pinned feeds fill every slot: nothing else stays on air.
    return { start, stop: [...stop, ...others.running.keys()] };
  }
  const rest = planRotating({ ...others, max: max > 0 ? max - pinnedWanted.length : 0 });
  return { start: [...start, ...rest.start], stop: [...stop, ...rest.stop] };
}

function planRotating({ wanted, running, lastEndedMs, now, max, rotateMs }: LivePlanInput) {
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

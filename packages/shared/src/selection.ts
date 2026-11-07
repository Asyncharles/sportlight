import { matchesFollows } from './catalogue.js';
import type { SelectionConfig } from './config.js';
import type { FeedId, FeedState, Follow, VoteValue } from './domain.js';
import type { SlotId } from './ws.js';

/**
 * Per-viewer feed selection.
 *
 * Pure and deterministic: `reconcile` takes the previous selection plus the latest feed snapshot and
 * returns the next selection. The client runs it on every update and on a short timer; it is shared
 * so the same rules can run server-side (e.g. for push notifications) later.
 *
 * Rules
 *  - Eligible feeds are live and match the viewer's follows. Ineligible feeds (ended, unavailable,
 *    filtered out) leave their slot immediately. So do feeds in side windows the viewer's layout
 *    doesn't show.
 *  - Main window policy, chosen by the viewer:
 *      `user`   — "stays on the user's choice": filled automatically only when empty (initially with
 *                 the highest-ranked feed, later when its feed stops being eligible).
 *      `follow` — "follows the action": additionally, once main has been up for `minDisplayMs`, a
 *                 visible side feed that out-ranks it by `replaceMargin` for the challenge window
 *                 swaps into main (both keep their players).
 *  - Empty side slots are filled immediately with the best unplaced feeds.
 *  - A side feed can be replaced automatically once it has been visible for `minDisplayMs`, when a
 *    challenger out-ranks the weakest such side feed by `replaceMargin` points continuously for
 *    `challengeMs` + `countdownMs`. During the final `countdownMs` the pending switch is reported in
 *    `upcoming` so the client can warn ("Switching to X in 3"). At most one replacement happens per
 *    reconcile, so changes never cascade.
 *  - While `locked`, nothing is replaced or swapped automatically; only feeds that can no longer be
 *    shown leave, and empty windows are still filled.
 *  - A pinned window behaves as if locked on its own: its feed is never replaced or moved
 *    automatically (nor pulled into main), and it stays even if it no longer matches the viewer's
 *    follows — it leaves only once it stops being live. The pin travels with the feed when the viewer
 *    moves it, and is dropped when the feed leaves.
 *  - Slots never reorder on score changes; feeds only move on promotion or when main is refilled.
 */

export const MAIN_SLOT: SlotId = 'main';
export const SIDE_SLOTS: readonly SlotId[] = ['side-1', 'side-2', 'side-3'];
export const ALL_SLOTS: readonly SlotId[] = [MAIN_SLOT, ...SIDE_SLOTS];

export type MainPolicy = 'user' | 'follow';

export interface SlotAssignment {
  feedId: FeedId;
  /** When the feed was placed in this slot (client clock, ms). */
  placedAt: number;
  origin: 'auto' | 'user';
  /** Held by the viewer: never replaced or moved automatically. */
  pinned?: boolean;
}

export interface SelectionState {
  slots: Record<SlotId, SlotAssignment | null>;
  /**
   * Challenge key → since when (ms) it has continuously qualified. Keys are the challenger's feed id
   * for side replacements and `main>` + feed id for a main-window takeover.
   */
  challengers: Record<string, number>;
}

/** Viewer-side options layered on top of the server's `SelectionConfig`. */
export interface ViewerSelectionOptions {
  /** Side windows the viewer's layout shows (defaults to all three). */
  sideSlots?: readonly SlotId[];
  /** Freeze automatic changes. */
  locked?: boolean;
  /** Warn for this long before an automatic switch. 0 disables the warning (default). */
  countdownMs?: number;
  mainPolicy?: MainPolicy;
}

export interface SelectionInput extends ViewerSelectionOptions {
  feeds: readonly FeedState[];
  follows: readonly Follow[];
  votes: Readonly<Record<FeedId, VoteValue>>;
  now: number;
  config: SelectionConfig;
}

export type SelectionChange =
  | { type: 'placed'; slot: SlotId; feedId: FeedId }
  | {
      type: 'removed';
      slot: SlotId;
      feedId: FeedId;
      reason: 'ended' | 'unavailable' | 'filtered' | 'missing' | 'layout';
    }
  | { type: 'replaced'; slot: SlotId; feedId: FeedId; previous: FeedId }
  | { type: 'moved'; from: SlotId; to: SlotId; feedId: FeedId };

/** An automatic switch that will happen at `at` unless the challenger falls back (or the viewer keeps). */
export interface UpcomingSwitch {
  /** The window that will change. */
  slot: SlotId;
  /** Incoming feed. */
  feedId: FeedId;
  /** Feed currently in `slot`. */
  previous: FeedId;
  /** `replace`: a hidden feed takes a side window. `promote`: a side feed swaps into main. */
  kind: 'replace' | 'promote';
  /** When the countdown started and when it completes (ms, client clock). */
  since: number;
  at: number;
  /** Challenge key in `SelectionState.challengers`. */
  key: string;
}

export interface ReconcileResult {
  state: SelectionState;
  changes: SelectionChange[];
  upcoming: UpcomingSwitch[];
}

export function emptySelection(): SelectionState {
  return { slots: { main: null, 'side-1': null, 'side-2': null, 'side-3': null }, challengers: {} };
}

export function isEligible(feed: FeedState, follows: readonly Follow[]): boolean {
  return feed.status === 'live' && matchesFollows(feed, follows);
}

/** Ranking score: provider intensity plus the viewer's personal vote adjustment. */
export function rankOf(feed: FeedState, votes: Readonly<Record<FeedId, VoteValue>>, config: SelectionConfig): number {
  const base = feed.intensity?.score ?? 0;
  const vote = votes[feed.id] ?? 0;
  const boost = vote > 0 ? config.voteBoost.up : vote < 0 ? config.voteBoost.down : 0;
  return base + boost;
}

/** Stable ordering: fresh intensity first, then rank, then id (determinism). */
function compareCandidates(a: Ranked, b: Ranked): number {
  if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
  if (b.rank !== a.rank) return b.rank - a.rank;
  return a.feed.id < b.feed.id ? -1 : a.feed.id > b.feed.id ? 1 : 0;
}

interface Ranked {
  feed: FeedState;
  rank: number;
  fresh: boolean;
}

export const MAIN_CHALLENGE_PREFIX = 'main>';

export function reconcile(prev: SelectionState, input: SelectionInput): ReconcileResult {
  const { feeds, follows, votes, now, config } = input;
  const sideSlots = input.sideSlots ?? SIDE_SLOTS;
  const countdownMs = Math.max(0, input.countdownMs ?? 0);
  const switchAfter = config.challengeMs + countdownMs;
  const slots: Record<SlotId, SlotAssignment | null> = { ...prev.slots };
  const changes: SelectionChange[] = [];
  const upcoming: UpcomingSwitch[] = [];

  const byId = new Map(feeds.map((f) => [f.id, f]));
  const ranked = new Map<FeedId, Ranked>();
  const pinnedIds = new Set(
    ALL_SLOTS.flatMap((s) => (slots[s]?.pinned ? [slots[s]!.feedId] : [])),
  );
  for (const feed of feeds) {
    if (!isEligible(feed, follows) && !(pinnedIds.has(feed.id) && feed.status === 'live')) continue;
    ranked.set(feed.id, { feed, rank: rankOf(feed, votes, config), fresh: !!feed.intensity && !feed.intensityStale });
  }

  // 1. Drop feeds that are no longer eligible, or sit in a window the layout doesn't show.
  for (const slot of ALL_SLOTS) {
    const a = slots[slot];
    if (!a) continue;
    if (slot !== MAIN_SLOT && !sideSlots.includes(slot)) {
      changes.push({ type: 'removed', slot, feedId: a.feedId, reason: 'layout' });
      slots[slot] = null;
      continue;
    }
    if (ranked.has(a.feedId)) continue;
    const feed = byId.get(a.feedId);
    const reason = !feed
      ? 'missing'
      : feed.status === 'ended'
        ? 'ended'
        : feed.status === 'unavailable'
          ? 'unavailable'
          : 'filtered';
    changes.push({ type: 'removed', slot, feedId: a.feedId, reason });
    slots[slot] = null;
  }

  const placed = () => new Set(ALL_SLOTS.map((s) => slots[s]?.feedId).filter((id): id is FeedId => !!id));
  const unplaced = () => {
    const taken = placed();
    return [...ranked.values()].filter((r) => !taken.has(r.feed.id)).sort(compareCandidates);
  };

  // 2. Refill main: best of the visible side feeds and unplaced candidates. Promoting a side feed
  //    keeps its player (and playback) and leaves the side slot to be refilled below.
  if (!slots.main) {
    const sideOptions = sideSlots.flatMap((slot) => {
      const a = slots[slot];
      const r = a && !a.pinned && ranked.get(a.feedId);
      return r ? [{ slot, r }] : [];
    });
    const bestUnplaced = unplaced()[0];
    const bestSide = sideOptions.sort((x, y) => compareCandidates(x.r, y.r))[0];
    if (bestSide && (!bestUnplaced || compareCandidates(bestSide.r, bestUnplaced) <= 0)) {
      slots.main = { feedId: bestSide.r.feed.id, placedAt: now, origin: 'auto' };
      slots[bestSide.slot] = null;
      changes.push({ type: 'moved', from: bestSide.slot, to: MAIN_SLOT, feedId: bestSide.r.feed.id });
    } else if (bestUnplaced) {
      slots.main = { feedId: bestUnplaced.feed.id, placedAt: now, origin: 'auto' };
      changes.push({ type: 'placed', slot: MAIN_SLOT, feedId: bestUnplaced.feed.id });
    }
  }

  // 3. Fill empty side slots in order.
  for (const slot of sideSlots) {
    if (slots[slot]) continue;
    const next = unplaced()[0];
    if (!next) break;
    slots[slot] = { feedId: next.feed.id, placedAt: now, origin: 'auto' };
    changes.push({ type: 'placed', slot, feedId: next.feed.id });
  }

  const challengers: Record<string, number> = {};
  if (input.locked) return { state: { slots, challengers }, changes, upcoming };

  // 4. Threshold replacement of the weakest side feed that has served its minimum display time.
  const replaceable = sideSlots
    .flatMap((slot) => {
      const a = slots[slot];
      const r = a && ranked.get(a.feedId);
      return a && r && !a.pinned && now - a.placedAt >= config.minDisplayMs ? [{ slot, a, r }] : [];
    })
    .sort((x, y) => x.r.rank - y.r.rank || (x.slot < y.slot ? -1 : 1));
  const target = replaceable[0];

  if (target) {
    let winner: Ranked | undefined;
    let leader: { c: Ranked; since: number } | undefined;
    for (const c of unplaced()) {
      if (!c.fresh || c.rank < target.r.rank + config.replaceMargin) continue;
      const since = prev.challengers[c.feed.id] ?? now;
      challengers[c.feed.id] = since;
      if (!winner && now - since >= switchAfter) winner = c;
      if (!leader || since < leader.since) leader = { c, since };
    }
    if (winner) {
      slots[target.slot] = { feedId: winner.feed.id, placedAt: now, origin: 'auto' };
      delete challengers[winner.feed.id];
      changes.push({ type: 'replaced', slot: target.slot, feedId: winner.feed.id, previous: target.a.feedId });
    } else if (leader && countdownMs > 0 && now - leader.since >= config.challengeMs) {
      upcoming.push({
        slot: target.slot,
        feedId: leader.c.feed.id,
        previous: target.a.feedId,
        kind: 'replace',
        since: leader.since + config.challengeMs,
        at: leader.since + switchAfter,
        key: leader.c.feed.id,
      });
    }
  }

  // 5. "Follow the action": a visible side feed that clearly out-ranks main swaps into it.
  const main = slots.main;
  const mainRank = main && ranked.get(main.feedId);
  const replacedThisPass = changes.some((c) => c.type === 'replaced');
  if (
    input.mainPolicy === 'follow' &&
    !replacedThisPass &&
    main &&
    !main.pinned &&
    mainRank &&
    now - main.placedAt >= config.minDisplayMs
  ) {
    const best = sideSlots
      .flatMap((slot) => {
        const a = slots[slot];
        const r = a && ranked.get(a.feedId);
        return a && r && !a.pinned && r.fresh && r.rank >= mainRank.rank + config.replaceMargin
          ? [{ slot, a, r }]
          : [];
      })
      .sort((x, y) => compareCandidates(x.r, y.r))[0];
    if (best) {
      const key = MAIN_CHALLENGE_PREFIX + best.r.feed.id;
      const since = prev.challengers[key] ?? now;
      if (now - since >= switchAfter) {
        slots.main = { feedId: best.r.feed.id, placedAt: now, origin: 'auto' };
        slots[best.slot] = { feedId: main.feedId, placedAt: now, origin: 'auto' };
        changes.push({ type: 'moved', from: best.slot, to: MAIN_SLOT, feedId: best.r.feed.id });
        changes.push({ type: 'moved', from: MAIN_SLOT, to: best.slot, feedId: main.feedId });
      } else {
        challengers[key] = since;
        if (countdownMs > 0 && now - since >= config.challengeMs) {
          upcoming.push({
            slot: MAIN_SLOT,
            feedId: best.r.feed.id,
            previous: main.feedId,
            kind: 'promote',
            since: since + config.challengeMs,
            at: since + switchAfter,
            key,
          });
        }
      }
    }
  }

  return { state: { slots, challengers }, changes, upcoming };
}

/**
 * User action: show `feedId` in the main window, immediately.
 *  - From a side slot: swap with the current main feed (which takes that side slot).
 *  - From outside the layout: the current main feed displaces the weakest side feed.
 * Either way the moved feeds restart their minimum display time.
 */
export function promote(
  prev: SelectionState,
  feedId: FeedId,
  now: number,
  rank: (feedId: FeedId) => number = () => 0,
  sideSlots: readonly SlotId[] = SIDE_SLOTS,
): SelectionState {
  if (prev.slots.main?.feedId === feedId) {
    return { ...prev, slots: { ...prev.slots, main: { ...prev.slots.main, origin: 'user' } } };
  }
  const slots = { ...prev.slots };
  const oldMain = slots.main;
  const fromSlot = sideSlots.find((s) => slots[s]?.feedId === feedId);
  const moved = (a: SlotAssignment): SlotAssignment => ({
    feedId: a.feedId,
    placedAt: now,
    origin: 'user',
    ...(a.pinned ? { pinned: true } : {}),
  });

  slots.main = fromSlot ? moved(slots[fromSlot]!) : { feedId, placedAt: now, origin: 'user' };
  if (fromSlot) {
    slots[fromSlot] = oldMain ? moved(oldMain) : null;
  } else if (oldMain && sideSlots.length > 0) {
    // The old main feed takes a free side window, else the weakest unpinned one.
    const free = sideSlots.find((s) => !slots[s]);
    const weakest = sideSlots
      .filter((s) => !slots[s]?.pinned)
      .sort((a, b) => rank(slots[a]?.feedId ?? '') - rank(slots[b]?.feedId ?? ''))[0];
    const to = free ?? weakest;
    if (to) slots[to] = moved(oldMain);
  }
  const challengers = { ...prev.challengers };
  delete challengers[feedId];
  delete challengers[MAIN_CHALLENGE_PREFIX + feedId];
  return { slots, challengers };
}

/**
 * User action: keep what's in `slot` (cancels a pending switch there). The feed restarts its minimum
 * display time and is marked as the viewer's choice.
 */
export function keep(prev: SelectionState, slot: SlotId, now: number): SelectionState {
  const a = prev.slots[slot];
  if (!a) return prev;
  const challengers = Object.fromEntries(
    Object.entries(prev.challengers).filter(([k]) =>
      slot === MAIN_SLOT ? !k.startsWith(MAIN_CHALLENGE_PREFIX) : k.startsWith(MAIN_CHALLENGE_PREFIX),
    ),
  );
  return { slots: { ...prev.slots, [slot]: { ...a, placedAt: now, origin: 'user' } }, challengers };
}

/** User action: pin or unpin the feed in `slot`. */
export function setPinned(prev: SelectionState, slot: SlotId, pinned: boolean, now: number): SelectionState {
  const a = prev.slots[slot];
  if (!a || !!a.pinned === pinned) return prev;
  const next: SlotAssignment = pinned
    ? { ...a, origin: 'user', pinned: true }
    : { feedId: a.feedId, placedAt: now, origin: a.origin };
  return { ...prev, slots: { ...prev.slots, [slot]: next } };
}

/**
 * User action: show `feedId` in `slot` and pin it there. If the feed is already in another window
 * the two swap (the displaced feed keeps its own pin); otherwise the slot's current feed is hidden.
 */
export function assign(prev: SelectionState, slot: SlotId, feedId: FeedId, now: number): SelectionState {
  const slots = { ...prev.slots };
  const current = slots[slot];
  const fromSlot = ALL_SLOTS.find((s) => s !== slot && slots[s]?.feedId === feedId);
  if (fromSlot) {
    slots[fromSlot] = current
      ? { feedId: current.feedId, placedAt: now, origin: 'user', ...(current.pinned ? { pinned: true } : {}) }
      : null;
  }
  slots[slot] = { feedId, placedAt: now, origin: 'user', pinned: true };
  const challengers = { ...prev.challengers };
  delete challengers[feedId];
  delete challengers[MAIN_CHALLENGE_PREFIX + feedId];
  return { slots, challengers };
}

/** User action: make a pending switch happen on the next reconcile. */
export function hurry(prev: SelectionState, key: string): SelectionState {
  if (!(key in prev.challengers)) return prev;
  return { ...prev, challengers: { ...prev.challengers, [key]: -Infinity } };
}

export function slotOf(state: SelectionState, feedId: FeedId): SlotId | undefined {
  return ALL_SLOTS.find((s) => state.slots[s]?.feedId === feedId);
}

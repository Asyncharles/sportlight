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
 *    filtered out) leave their slot immediately.
 *  - Main window policy — "stays on the user's choice": it is filled automatically only when empty
 *    (initially with the highest-ranked feed, later when its feed stops being eligible). Otherwise
 *    only the user changes it.
 *  - Empty side slots are filled immediately with the best unplaced feeds.
 *  - A side feed can be replaced automatically once it has been visible for `minDisplayMs`, when a
 *    challenger out-ranks the weakest such side feed by `replaceMargin` points continuously for
 *    `challengeMs`. At most one replacement happens per reconcile, so changes never cascade.
 *  - Slots never reorder on score changes; feeds only move on promotion or when main is refilled.
 */

export const MAIN_SLOT: SlotId = 'main';
export const SIDE_SLOTS: readonly SlotId[] = ['side-1', 'side-2', 'side-3'];
export const ALL_SLOTS: readonly SlotId[] = [MAIN_SLOT, ...SIDE_SLOTS];

export interface SlotAssignment {
  feedId: FeedId;
  /** When the feed was placed in this slot (client clock, ms). */
  placedAt: number;
  origin: 'auto' | 'user';
}

export interface SelectionState {
  slots: Record<SlotId, SlotAssignment | null>;
  /** feedId → since when (ms) it has continuously qualified as a challenger. */
  challengers: Record<FeedId, number>;
}

export interface SelectionInput {
  feeds: readonly FeedState[];
  follows: readonly Follow[];
  votes: Readonly<Record<FeedId, VoteValue>>;
  now: number;
  config: SelectionConfig;
}

export type SelectionChange =
  | { type: 'placed'; slot: SlotId; feedId: FeedId }
  | { type: 'removed'; slot: SlotId; feedId: FeedId; reason: 'ended' | 'unavailable' | 'filtered' | 'missing' }
  | { type: 'replaced'; slot: SlotId; feedId: FeedId; previous: FeedId }
  | { type: 'moved'; from: SlotId; to: SlotId; feedId: FeedId };

export interface ReconcileResult {
  state: SelectionState;
  changes: SelectionChange[];
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

export function reconcile(prev: SelectionState, input: SelectionInput): ReconcileResult {
  const { feeds, follows, votes, now, config } = input;
  const slots: Record<SlotId, SlotAssignment | null> = { ...prev.slots };
  const changes: SelectionChange[] = [];

  const byId = new Map(feeds.map((f) => [f.id, f]));
  const ranked = new Map<FeedId, Ranked>();
  for (const feed of feeds) {
    if (!isEligible(feed, follows)) continue;
    ranked.set(feed.id, { feed, rank: rankOf(feed, votes, config), fresh: !!feed.intensity && !feed.intensityStale });
  }

  // 1. Drop feeds that are no longer eligible.
  for (const slot of ALL_SLOTS) {
    const a = slots[slot];
    if (!a || ranked.has(a.feedId)) continue;
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
    const sideOptions = SIDE_SLOTS.flatMap((slot) => {
      const a = slots[slot];
      const r = a && ranked.get(a.feedId);
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
  for (const slot of SIDE_SLOTS) {
    if (slots[slot]) continue;
    const next = unplaced()[0];
    if (!next) break;
    slots[slot] = { feedId: next.feed.id, placedAt: now, origin: 'auto' };
    changes.push({ type: 'placed', slot, feedId: next.feed.id });
  }

  // 4. Threshold replacement of the weakest side feed that has served its minimum display time.
  const challengers: Record<FeedId, number> = {};
  const replaceable = SIDE_SLOTS.flatMap((slot) => {
    const a = slots[slot];
    const r = a && ranked.get(a.feedId);
    return a && r && now - a.placedAt >= config.minDisplayMs ? [{ slot, a, r }] : [];
  }).sort((x, y) => x.r.rank - y.r.rank || (x.slot < y.slot ? -1 : 1));
  const target = replaceable[0];

  if (target) {
    let winner: Ranked | undefined;
    for (const c of unplaced()) {
      if (!c.fresh || c.rank < target.r.rank + config.replaceMargin) continue;
      const since = prev.challengers[c.feed.id] ?? now;
      challengers[c.feed.id] = since;
      if (!winner && now - since >= config.challengeMs) winner = c;
    }
    if (winner) {
      slots[target.slot] = { feedId: winner.feed.id, placedAt: now, origin: 'auto' };
      delete challengers[winner.feed.id];
      changes.push({ type: 'replaced', slot: target.slot, feedId: winner.feed.id, previous: target.a.feedId });
    }
  }

  return { state: { slots, challengers }, changes };
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
): SelectionState {
  if (prev.slots.main?.feedId === feedId) {
    return { ...prev, slots: { ...prev.slots, main: { ...prev.slots.main, origin: 'user' } } };
  }
  const slots = { ...prev.slots };
  const oldMain = slots.main;
  const fromSlot = SIDE_SLOTS.find((s) => slots[s]?.feedId === feedId);

  slots.main = { feedId, placedAt: now, origin: 'user' };
  if (fromSlot) {
    slots[fromSlot] = oldMain ? { feedId: oldMain.feedId, placedAt: now, origin: 'user' } : null;
  } else if (oldMain) {
    const free = SIDE_SLOTS.find((s) => !slots[s]);
    const weakest = [...SIDE_SLOTS].sort((a, b) => rank(slots[a]?.feedId ?? '') - rank(slots[b]?.feedId ?? ''))[0]!;
    slots[free ?? weakest] = { feedId: oldMain.feedId, placedAt: now, origin: 'user' };
  }
  const challengers = { ...prev.challengers };
  delete challengers[feedId];
  return { slots, challengers };
}

export function slotOf(state: SelectionState, feedId: FeedId): SlotId | undefined {
  return ALL_SLOTS.find((s) => state.slots[s]?.feedId === feedId);
}

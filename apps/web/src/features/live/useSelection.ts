import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ALL_SLOTS,
  assign as assignFeed,
  DEFAULT_SELECTION_CONFIG,
  emptySelection,
  hurry as hurrySwitch,
  keep as keepSlot,
  promote as promoteFeed,
  rankOf,
  reconcile,
  setPinned,
  type FeedState,
  type Follow,
  type SelectionChange,
  type SelectionConfig,
  type SelectionState,
  type SlotId,
  type UpcomingSwitch,
  type ViewerSelectionOptions,
  type VoteValue,
} from '@sportlight/shared';
import { Store } from '../../lib/store';

/** Survives navigation, so returning to the live page keeps the viewer's windows. */
const selectionStore = new Store<SelectionState>(emptySelection());

const RECONCILE_MS = 250;

const signature = (s: SelectionState) =>
  ALL_SLOTS.map((slot) => `${s.slots[slot]?.feedId ?? '-'}${s.slots[slot]?.pinned ? '*' : ''}`).join('|');
const upcomingSignature = (u: UpcomingSwitch[]) => u.map((x) => `${x.slot}:${x.feedId}:${x.at}`).join('|');

/**
 * Runs the shared selection engine for this viewer: on every feed update and on a short timer
 * (minimum display time, challenge windows and countdowns are time-based).
 */
export function useSelection(
  feeds: readonly FeedState[],
  follows: readonly Follow[],
  votes: Record<string, VoteValue>,
  config: SelectionConfig | null | undefined,
  options: ViewerSelectionOptions,
  enabled: boolean,
) {
  const [sig, setSig] = useState(() => signature(selectionStore.get()));
  const [lastChanges, setLastChanges] = useState<SelectionChange[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingSwitch[]>([]);
  const cfg = config ?? DEFAULT_SELECTION_CONFIG;
  const inputs = useRef({ feeds, follows, votes, config: cfg, options });
  inputs.current = { feeds, follows, votes, config: cfg, options };

  const step = useCallback(() => {
    if (!enabled) return;
    const { feeds: fs, follows: fl, votes: vs, config: c, options: o } = inputs.current;
    const { state, changes, upcoming: next } = reconcile(selectionStore.get(), {
      feeds: fs,
      follows: fl,
      votes: vs,
      config: c,
      ...o,
      now: Date.now(),
    });
    selectionStore.set(state);
    const s = signature(state);
    setSig((prev) => (prev === s ? prev : s));
    setUpcoming((prev) => (upcomingSignature(prev) === upcomingSignature(next) ? prev : next));
    if (changes.length) setLastChanges(changes);
  }, [enabled]);

  const optionsKey = JSON.stringify(options);
  useEffect(step, [feeds, follows, votes, config, optionsKey, step]);
  useEffect(() => {
    const t = window.setInterval(step, RECONCILE_MS);
    return () => clearInterval(t);
  }, [step]);

  const promote = useCallback((feedId: string) => {
    const { feeds: fs, votes: vs, config: c, options: o } = inputs.current;
    const byId = new Map(fs.map((f) => [f.id, f]));
    const next = promoteFeed(
      selectionStore.get(),
      feedId,
      Date.now(),
      (id) => {
        const f = byId.get(id);
        return f ? rankOf(f, vs, c) : -Infinity;
      },
      o.sideSlots,
    );
    selectionStore.set(next);
    setSig(signature(next));
    setUpcoming([]);
    setLastChanges([{ type: 'moved', from: 'side-1', to: 'main', feedId }]);
  }, []);

  /** Keep what's in a window (cancels its pending switch). */
  const keep = useCallback(
    (slot: SlotId) => {
      selectionStore.set(keepSlot(selectionStore.get(), slot, Date.now()));
      setUpcoming((u) => u.filter((x) => x.slot !== slot));
      step();
    },
    [step],
  );

  /** Pin or unpin the feed in a window (a pinned window is never switched automatically). */
  const pin = useCallback(
    (slot: SlotId, pinned: boolean) => {
      selectionStore.set(setPinned(selectionStore.get(), slot, pinned, Date.now()));
      setUpcoming((u) => u.filter((x) => x.slot !== slot));
      step();
    },
    [step],
  );

  /** Show a chosen feed in a window and pin it there. */
  const choose = useCallback(
    (slot: SlotId, feedId: string) => {
      selectionStore.set(assignFeed(selectionStore.get(), slot, feedId, Date.now()));
      setUpcoming((u) => u.filter((x) => x.slot !== slot));
      step();
    },
    [step],
  );

  /** Make a pending switch happen now. */
  const hurry = useCallback(
    (key: string) => {
      selectionStore.set(hurrySwitch(selectionStore.get(), key));
      step();
    },
    [step],
  );

  const byId = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);
  const assignment = useMemo(() => {
    const s = selectionStore.get();
    return Object.fromEntries(ALL_SLOTS.map((slot) => [slot, byId.get(s.slots[slot]?.feedId ?? '') ?? null])) as Record<
      SlotId,
      FeedState | null
    >;
    // `sig` captures slot membership; `byId` carries fresh feed data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, byId]);

  const pinned = useMemo(() => {
    const s = selectionStore.get();
    return Object.fromEntries(ALL_SLOTS.map((slot) => [slot, !!s.slots[slot]?.pinned])) as Record<SlotId, boolean>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  return { assignment, pinned, promote, keep, pin, choose, hurry, upcoming, lastChanges };
}

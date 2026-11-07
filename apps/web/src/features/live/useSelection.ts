import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ALL_SLOTS,
  DEFAULT_SELECTION_CONFIG,
  emptySelection,
  promote as promoteFeed,
  rankOf,
  reconcile,
  type FeedState,
  type Follow,
  type SelectionChange,
  type SelectionConfig,
  type SelectionState,
  type SlotId,
  type VoteValue,
} from '@sportlight/shared';
import { Store } from '../../lib/store';

/** Survives navigation, so returning to the live page keeps the viewer's windows. */
const selectionStore = new Store<SelectionState>(emptySelection());

const RECONCILE_MS = 500;

const signature = (s: SelectionState) => ALL_SLOTS.map((slot) => s.slots[slot]?.feedId ?? '-').join('|');

/**
 * Runs the shared selection engine for this viewer: on every feed update and on a short timer
 * (minimum display time and challenge windows are time-based).
 */
export function useSelection(
  feeds: readonly FeedState[],
  follows: readonly Follow[],
  votes: Record<string, VoteValue>,
  config: SelectionConfig | null | undefined,
  enabled: boolean,
) {
  const [sig, setSig] = useState(() => signature(selectionStore.get()));
  const [lastChanges, setLastChanges] = useState<SelectionChange[]>([]);
  const inputs = useRef({ feeds, follows, votes, config: config ?? DEFAULT_SELECTION_CONFIG });
  inputs.current = { feeds, follows, votes, config: config ?? DEFAULT_SELECTION_CONFIG };

  const step = useCallback(() => {
    if (!enabled) return;
    const { state, changes } = reconcile(selectionStore.get(), { ...inputs.current, now: Date.now() });
    selectionStore.set(state);
    const next = signature(state);
    setSig((prev) => (prev === next ? prev : next));
    if (changes.length) setLastChanges(changes);
  }, [enabled]);

  useEffect(step, [feeds, follows, votes, config, step]);
  useEffect(() => {
    const t = window.setInterval(step, RECONCILE_MS);
    return () => clearInterval(t);
  }, [step]);

  const promote = useCallback((feedId: string) => {
    const { feeds: fs, votes: vs, config: cfg } = inputs.current;
    const byId = new Map(fs.map((f) => [f.id, f]));
    const next = promoteFeed(selectionStore.get(), feedId, Date.now(), (id) => {
      const f = byId.get(id);
      return f ? rankOf(f, vs, cfg) : -Infinity;
    });
    selectionStore.set(next);
    setSig(signature(next));
    setLastChanges([{ type: 'moved', from: 'side-1', to: 'main', feedId }]);
  }, []);

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

  return { assignment, promote, lastChanges };
}

import { useMemo } from 'react';
import type { FeedId, FeedState, VoteValue } from '@sportlight/shared';
import { live } from './live-client';
import { Store, storage, useStore } from './store';

/**
 * Viewer votes. A vote is the viewer's own signal, kept separate from the provider intensity:
 * it nudges this viewer's ranking (see SelectionConfig.voteBoost) and is aggregated on the backend.
 * Votes are per run, so they reset when a feed restarts.
 */
const KEY = 'sportlight.votes.v1';
type VoteMap = Record<string, { value: VoteValue; at: number }>;

const MAX_AGE_MS = 24 * 3_600_000;
const initial = Object.fromEntries(
  Object.entries(storage.read<VoteMap>(KEY, {})).filter(([, v]) => Date.now() - v.at < MAX_AGE_MS),
);
const votesStore = new Store<VoteMap>(initial);
votesStore.subscribe(() => storage.write(KEY, votesStore.get()));

const keyOf = (feed: Pick<FeedState, 'id' | 'runId'>) => `${feed.id}|${feed.runId}`;

export function castVote(feed: Pick<FeedState, 'id' | 'runId'>, value: VoteValue) {
  votesStore.set((m) => {
    const next = { ...m };
    if (value === 0) delete next[keyOf(feed)];
    else next[keyOf(feed)] = { value, at: Date.now() };
    return next;
  });
  live.send({ type: 'vote', feedId: feed.id, runId: feed.runId, value });
}

/** Current votes for the given feeds, keyed by feed id (as the selection engine expects). */
export function useVotes(feeds: readonly FeedState[]): Record<FeedId, VoteValue> {
  const all = useStore(votesStore);
  return useMemo(() => {
    const out: Record<FeedId, VoteValue> = {};
    for (const f of feeds) {
      const v = all[keyOf(f)];
      if (v) out[f.id] = v.value;
    }
    return out;
  }, [all, feeds]);
}

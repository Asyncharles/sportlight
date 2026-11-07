import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import {
  ALL_SLOTS,
  DEFAULT_HIGHLIGHT_CONFIG,
  matchesFollows,
  type FeedState,
  type ViewerTile,
  type VoteValue,
} from '@sportlight/shared';
import { live, useLive } from '../../lib/live-client';
import { usePreferences } from '../../lib/preferences';
import { castVote, useVotes } from '../../lib/votes';
import { LiveStage } from './LiveStage';
import type { PlaybackStatus } from './useLivePlayback';
import { useSelection } from './useSelection';
import styles from './LivePage.module.scss';

const REPORT_MS = 2000;

export function LivePage() {
  const { feeds: feedMap, ready, status, config } = useLive();
  const { prefs } = usePreferences();
  const feeds = useMemo(() => Object.values(feedMap), [feedMap]);
  const votes = useVotes(feeds);
  const { assignment, promote, lastChanges } = useSelection(feeds, prefs.follows, votes, config?.selection, ready);
  const [audioOn, setAudioOn] = useState(false);
  const statuses = useRef(new Map<string, PlaybackStatus>());

  const eligibleCount = useMemo(
    () => feeds.filter((f) => f.status === 'live' && matchesFollows(f, prefs.follows)).length,
    [feeds, prefs.follows],
  );
  const otherLive = useMemo(
    () => feeds.filter((f) => f.status === 'live' && !matchesFollows(f, prefs.follows)).length,
    [feeds, prefs.follows],
  );

  const onStatus = useCallback((feedId: string, s: PlaybackStatus) => statuses.current.set(feedId, s), []);
  const onVote = useCallback((feed: FeedState, value: VoteValue) => castVote(feed, value), []);
  const onToggleAudio = useCallback(() => setAudioOn((a) => !a), []);
  const onAutoplayBlocked = useCallback(() => setAudioOn(false), []);

  // Report what this viewer is watching (per-viewer state for the backend/admin view).
  useEffect(() => {
    const report = () => {
      const tiles: ViewerTile[] = ALL_SLOTS.flatMap((slot) => {
        const f = assignment[slot];
        if (!f) return [];
        const s = statuses.current.get(f.id);
        return [
          {
            slot,
            feedId: f.id,
            lagSec: s?.lagSec ?? 0,
            playback: s?.phase === 'ended' ? 'paused' : (s?.phase ?? 'loading'),
          },
        ];
      });
      live.reportViewerState({ type: 'viewer.state', follows: prefs.follows, tiles });
    };
    report();
    const t = window.setInterval(report, REPORT_MS);
    return () => clearInterval(t);
  }, [assignment, prefs.follows]);

  // Leaving the live page: this viewer is no longer watching anything.
  const followsRef = useRef(prefs.follows);
  followsRef.current = prefs.follows;
  useEffect(() => () => live.reportViewerState({ type: 'viewer.state', follows: followsRef.current, tiles: [] }), []);

  // Announce window changes for screen-reader users.
  const announcement = useMemo(() => {
    const mainChanged = lastChanges.some(
      (c) => (c.type === 'moved' && c.to === 'main') || (c.type === 'placed' && c.slot === 'main'),
    );
    const main = assignment.main;
    if (mainChanged && main) return `Now in the main window: ${main.event.title}`;
    const replaced = lastChanges.find((c) => c.type === 'replaced');
    if (replaced) {
      const f = feedMap[replaced.feedId];
      return f ? `${f.event.title} joined the side windows` : '';
    }
    return '';
  }, [lastChanges, assignment.main, feedMap]);

  const empty = ready && eligibleCount === 0;

  return (
    <main className={styles.page}>
      <h1 className="sr-only">Live</h1>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      {empty ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing live in your sports right now</p>
          <p className={styles.emptyText}>
            {otherLive > 0
              ? `${otherLive} ${otherLive === 1 ? 'feed is' : 'feeds are'} live in other sports.`
              : status === 'open'
                ? 'We’ll bring feeds in the moment they start.'
                : 'Reconnecting to the live service…'}
          </p>
          <Link to="/settings#sports" className="sl-button small">
            <SlidersHorizontal size={16} /> Choose sports
          </Link>
        </div>
      ) : (
        <LiveStage
          assignment={assignment}
          loading={!ready}
          audioOn={audioOn}
          connected={status === 'open'}
          hotThreshold={config?.highlights.enterThreshold ?? DEFAULT_HIGHLIGHT_CONFIG.enterThreshold}
          votes={votes}
          onVote={onVote}
          onPromote={promote}
          onToggleAudio={onToggleAudio}
          onAutoplayBlocked={onAutoplayBlocked}
          onStatus={onStatus}
        />
      )}
    </main>
  );
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useIsPhone, useReducedMotion } from '../../lib/hooks';
import { live, useLive } from '../../lib/live-client';
import { effectiveSelectionConfig, setVoiceHandler, useLiveUi, viewerOptions, type VoiceHandler } from '../../lib/live-ui';
import { usePreferences } from '../../lib/preferences';
import { castVote, useVotes } from '../../lib/votes';
import { LiveStage } from './LiveStage';
import { resolveVoiceAlternatives, voiceExamples } from './voiceCommands';
import { activeLayout, layoutDef, uses3d } from '../../lib/live-ui';
import { LiveTour } from './LiveTour';
import type { PlaybackStatus } from './useLivePlayback';
import { useSelection } from './useSelection';
import styles from './LivePage.module.scss';

const SpatialStage = lazy(() => import('./SpatialStage'));
const REPORT_MS = 2000;

export function LivePage() {
  const { feeds: feedMap, ready, status, config } = useLive();
  const { prefs } = usePreferences();
  const ui = useLiveUi();
  const reducedMotion = useReducedMotion();
  const phone = useIsPhone();
  const layout = activeLayout(prefs.live, phone);
  const feeds = useMemo(() => Object.values(feedMap), [feedMap]);
  const votes = useVotes(feeds);
  const selectionConfig = useMemo(
    () => effectiveSelectionConfig(config?.selection, prefs.live),
    [config?.selection, prefs.live],
  );
  const options = useMemo(() => viewerOptions(prefs.live, ui.locked, phone), [prefs.live, ui.locked, phone]);
  const { assignment, pinned, promote, keep, pin, choose, hurry, upcoming, lastChanges } = useSelection(
    feeds,
    prefs.follows,
    votes,
    selectionConfig,
    options,
    ready,
  );
  useEffect(() => {
    if (!ui.requestedFeedId || !ready) return;
    promote(ui.requestedFeedId);
    ui.requestFeed(undefined);
  }, [ui.requestedFeedId, ui.requestFeed, ready, promote]);

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

  // Keyboard: L toggles the lock (when focus isn't in a text field).
  const { toggleLocked } = ui;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'l' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      toggleLocked();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleLocked]);

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

  // Voice commands from the header mic act on this page's windows.
  const onVoice = useRef<VoiceHandler>({ run: () => ({ reply: '', ok: false }), examples: () => [] });
  const voiceFeeds = feeds.filter((f) => matchesFollows(f, prefs.follows));
  onVoice.current = {
    examples: () => voiceExamples(voiceFeeds),
    run: (alternatives) => {
      const { command, understood: text, corrected: changed } = resolveVoiceAlternatives(
        alternatives,
        voiceFeeds,
        [assignment.main, ...layoutDef(layout).sideSlots.map((slot) => assignment[slot])],
        assignment.main?.id,
      );
      const corrected = changed ? text : undefined;
      if (command.type === 'message') return { reply: command.message, ok: false };
      if (command.type === 'audio') {
        setAudioOn(command.enabled);
        return {
          ok: true,
          understood: corrected,
          reply: command.enabled ? 'Sound enabled. If playback stays muted, use the speaker button.' : 'Sound muted.',
        };
      }
      choose('main', command.feed.id);
      return { ok: true, understood: corrected, reply: `Showing ${command.feed.event.title}. Main screen pinned to this feed.` };
    },
  };
  useEffect(
    () => setVoiceHandler({ run: (a) => onVoice.current.run(a), examples: () => onVoice.current.examples() }),
    [],
  );

  const empty = ready && eligibleCount === 0;
  const Stage = uses3d(prefs.live, phone) ? SpatialStage : LiveStage;

  return (
    <main className={styles.page} data-view-stage data-tour="stage">
      <h1 className="sr-only">Live</h1>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      <div className={styles.viewingArea}>
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
            <Link to="/settings/sports" className="sl-button small">
              <SlidersHorizontal size={16} /> Choose sports
            </Link>
          </div>
        ) : (
          <Suspense fallback={<div className={styles.empty}>Opening the viewing room…</div>}>
            <Stage
              assignment={assignment}
              feeds={feeds}
              follows={prefs.follows}
              selectionConfig={selectionConfig}
              upcoming={upcoming}
              layout={layout}
              phone={phone}
              sidebar={prefs.live.sidebar}
              animation={prefs.live.animation}
              reducedMotion={reducedMotion}
              tableExpanded={ui.tableExpanded}
              onTableExpanded={ui.setTableExpanded}
              onKeep={keep}
              pinned={pinned}
              locked={ui.locked}
              onPin={pin}
              onChoose={choose}
              onHurry={hurry}
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
          </Suspense>
        )}
        <LiveTour />
      </div>
    </main>
  );
}

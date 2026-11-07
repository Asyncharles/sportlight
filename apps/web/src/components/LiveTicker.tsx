import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_HIGHLIGHT_CONFIG, matchesFollows } from '@sportlight/shared';
import { Ticker, useTape } from '../features/live/SpatialPanels';
import { useReducedMotion } from '../lib/hooks';
import { useLive } from '../lib/live-client';
import { useLiveUi } from '../lib/live-ui';
import { usePreferences } from '../lib/preferences';

export function LiveTicker() {
  const { feeds: feedMap, config } = useLive();
  const { prefs } = usePreferences();
  const { requestFeed } = useLiveUi();
  const navigate = useNavigate();
  const reducedMotion = useReducedMotion();
  const feeds = useMemo(() => Object.values(feedMap).filter(
    (feed) => feed.status === 'live' && matchesFollows(feed, prefs.follows),
  ), [feedMap, prefs.follows]);
  const tape = useTape(feeds);
  return <Ticker feeds={feeds} tape={tape}
    hotThreshold={config?.highlights.enterThreshold ?? DEFAULT_HIGHLIGHT_CONFIG.enterThreshold}
    reducedMotion={reducedMotion}
    onPick={(id) => { requestFeed(id); navigate('/live'); }} />;
}

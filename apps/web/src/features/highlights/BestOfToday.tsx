import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUp, SlidersHorizontal, Sparkles } from 'lucide-react';
import { assignTiers, matchesFollows, type HighlightTier } from '@sportlight/shared';
import { useHighlights } from '../../lib/highlights';
import { formatDay } from '../../lib/format';
import { usePreferences } from '../../lib/preferences';
import { HighlightTile } from './HighlightTile';
import styles from './BestOfToday.module.scss';

/**
 * Today's most intense moments in a dense grid. Tile size follows peak intensity (three sizes).
 * New highlights don't reflow the grid under the viewer; they are offered via a "new moments" pill.
 */
export function BestOfToday() {
  const { highlights, day, timezone, status } = useHighlights();
  const { prefs, sports } = usePreferences();
  const [allSports, setAllSports] = useState(false);

  const filtered = useMemo(
    () => (allSports ? highlights : highlights.filter((h) => matchesFollows(h, prefs.follows))),
    [highlights, prefs.follows, allSports],
  );

  // Freeze the visible set; surface new arrivals without moving tiles around.
  const [shownIds, setShownIds] = useState<Set<string> | null>(null);
  const firstLoad = useRef(true);
  useEffect(() => {
    if (status !== 'ready') return;
    if (firstLoad.current || shownIds === null) {
      firstLoad.current = false;
      setShownIds(new Set(filtered.map((h) => h.id)));
    }
  }, [status, filtered, shownIds]);
  useEffect(() => setShownIds(null), [allSports, prefs.follows]);

  const visible = useMemo(
    () => (shownIds ? filtered.filter((h) => shownIds.has(h.id)) : filtered),
    [filtered, shownIds],
  );
  const pending = shownIds ? filtered.length - visible.length : 0;
  const tiers = useMemo(() => assignTiers(visible), [visible]);
  const showNew = () => {
    setShownIds(new Set(filtered.map((h) => h.id)));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <main className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Best of Today</h1>
          <p className={styles.sub}>
            {day ? formatDay(day) : 'Today'}
            {visible.length > 0 && ` · ${visible.length} ${visible.length === 1 ? 'moment' : 'moments'}`}
          </p>
        </div>
        <div className={styles.filters} role="group" aria-label="Filter">
          <button
            type="button"
            className={`${styles.chip} ${!allSports ? styles.chipOn : ''}`}
            aria-pressed={!allSports}
            onClick={() => setAllSports(false)}
          >
            Your sports · {sports.length}
          </button>
          <button
            type="button"
            className={`${styles.chip} ${allSports ? styles.chipOn : ''}`}
            aria-pressed={allSports}
            onClick={() => setAllSports(true)}
          >
            All sports
          </button>
          <Link to="/settings#sports" className={styles.iconChip} aria-label="Edit your sports">
            <SlidersHorizontal size={15} />
          </Link>
        </div>
      </div>

      {pending > 0 && (
        <button type="button" className={styles.newPill} onClick={showNew}>
          <ArrowUp size={15} /> {pending} new {pending === 1 ? 'moment' : 'moments'}
        </button>
      )}

      {status === 'loading' ? (
        <div className={styles.grid} aria-busy>
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className={`${styles.skeleton} ${i === 0 ? styles.large : i < 3 ? styles.medium : ''}`} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className={styles.empty}>
          <Sparkles size={22} strokeWidth={1.75} />
          <p className={styles.emptyTitle}>
            {status === 'error' ? 'Highlights are unavailable right now' : 'No standout moments yet today'}
          </p>
          <p className={styles.emptyText}>
            {status === 'error'
              ? 'We’ll retry when the connection comes back.'
              : !allSports && highlights.length > 0
                ? `${highlights.length} ${highlights.length === 1 ? 'moment' : 'moments'} in other sports.`
                : 'Moments appear here as soon as live intensity peaks.'}
          </p>
          {!allSports && highlights.length > 0 && (
            <button type="button" className="sl-button small secondary" onClick={() => setAllSports(true)}>
              Show all sports
            </button>
          )}
        </div>
      ) : (
        <ul className={styles.grid}>
          {visible.map((h) => (
            <li key={h.id} className={tierClass(tiers.get(h.id))}>
              <HighlightTile highlight={h} tier={tiers.get(h.id) ?? 'small'} timezone={timezone ?? undefined} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function tierClass(tier: HighlightTier | undefined) {
  return tier === 'large' ? styles.large : tier === 'medium' ? styles.medium : styles.small;
}

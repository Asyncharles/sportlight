import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowUp, Sparkles } from 'lucide-react';
import { assignTiers, SPORTS, type HighlightTier } from '@sportlight/shared';
import { matchesBestFilter, useBestUi } from '../../lib/best-ui';
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
  const { prefs } = usePreferences();
  const { sports, setSports } = useBestUi();
  const allSports = sports?.length === SPORTS.length;

  const filtered = useMemo(
    () => highlights.filter((h) => matchesBestFilter(h, sports, prefs.follows)),
    [highlights, prefs.follows, sports],
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
  useEffect(() => setShownIds(null), [sports, prefs.follows]);

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
      <h1 className="sr-only">
        Best of Today{day ? `, ${formatDay(day)}` : ''}
      </h1>

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
                ? `${highlights.length} ${highlights.length === 1 ? 'moment' : 'moments'} outside this filter.`
                : 'Moments appear here as soon as live intensity peaks.'}
          </p>
          {!allSports && highlights.length > 0 && (
            <button type="button" className="sl-button small secondary" onClick={() => setSports(SPORTS.map((s) => s.id))}>
              Show all sports
            </button>
          )}
        </div>
      ) : (
        <ul className={styles.grid}>
          {visible.map((h, index) => (
            <li key={h.id} className={tierClass(tiers.get(h.id))} style={{ '--reveal-delay': `${Math.min(index, 8) * 55}ms` } as CSSProperties}>
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

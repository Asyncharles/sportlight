import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightLeft, Minimize2, Maximize2, TrendingDown, TrendingUp } from 'lucide-react';
import {
  getCompetition,
  isEligible,
  rankOf,
  type FeedState,
  type Follow,
  type SelectionConfig,
  type SlotId,
  type UpcomingSwitch,
  type VoteValue,
} from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { TrendLine } from '../../components/TrendLine';
import { screenNumber } from '../../lib/live-ui';
import { trendOf, useIntensityTrail, windowed } from '../../lib/intensity-trail';
import styles from './FeedTable.module.scss';

const RESORT_MS = 2500;
const ROW_H = 34;
const ROW_H_EXPANDED = 54;

interface Props {
  feeds: readonly FeedState[];
  follows: readonly Follow[];
  assignment: Record<SlotId, FeedState | null>;
  upcoming: UpcomingSwitch[];
  votes: Record<string, VoteValue>;
  config: SelectionConfig;
  connected: boolean;
  hotThreshold: number;
  expanded: boolean;
  /** Omitted when the table already fills the sidebar (no expand control). */
  onExpanded?: (expanded: boolean) => void;
  onPromote: (feedId: string) => void;
}

const SLOT_LABEL: Record<SlotId, string> = {
  main: 'screen 1 (main)',
  'side-1': 'screen 2',
  'side-2': 'screen 3',
  'side-3': 'screen 4',
};

/**
 * A concise, always-current table of every live feed in the viewer's sports, ranked by intensity.
 * Rows re-sort every few seconds (not on every reading) and glide to their new positions. Expanding
 * fills the whole sidebar with taller rows that add broadcaster, competition and a longer trend.
 */
export function FeedTable(props: Props) {
  const { feeds, follows, assignment, upcoming, votes, config, expanded } = props;
  const eligible = useMemo(() => feeds.filter((f) => isEligible(f, follows)), [feeds, follows]);
  const otherLive = useMemo(
    () => feeds.filter((f) => f.status === 'live' && !isEligible(f, follows)).length,
    [feeds, follows],
  );

  // Ordering is refreshed on a slow beat (and immediately when membership changes) so rows don't
  // shuffle with every 1 Hz reading.
  const rankRef = useRef<(f: FeedState) => number>(() => 0);
  rankRef.current = (f) => rankOf(f, votes, config);
  const membership = eligible.map((f) => f.id).sort().join('|');
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    const sort = () =>
      setOrder(
        [...eligible]
          .sort((a, b) => rankRef.current(b) - rankRef.current(a) || (a.id < b.id ? -1 : 1))
          .map((f) => f.id),
      );
    sort();
    const t = window.setInterval(sort, RESORT_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership]);

  const slotOf = useMemo(() => {
    const m = new Map<string, SlotId>();
    for (const [slot, f] of Object.entries(assignment)) if (f) m.set(f.id, slot as SlotId);
    return m;
  }, [assignment]);
  const upcomingFor = useMemo(() => new Map(upcoming.map((u) => [u.feedId, u])), [upcoming]);
  const byId = useMemo(() => new Map(eligible.map((f) => [f.id, f])), [eligible]);
  const rows = order.map((id) => byId.get(id)).filter((f): f is FeedState => !!f);
  const rowH = expanded ? ROW_H_EXPANDED : ROW_H;

  return (
    <section className={`${styles.table} ${expanded ? styles.expanded : ''}`} aria-label="Live feeds">
      <header className={styles.head}>
        <span className={styles.heading}>
          Live now <span className={`${styles.count} mono`}>{eligible.length}</span>
        </span>
        <span className={styles.colLabel}>{expanded ? '60 s trend' : 'Trend'}</span>
        {props.onExpanded && (
        <button
          type="button"
          className={styles.expand}
          onClick={() => props.onExpanded?.(!expanded)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse live table' : 'Expand live table to the whole sidebar'}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        )}
      </header>

      <div className={styles.body}>
        {rows.length === 0 ? (
          <p className={styles.empty}>No live feeds in your sports.</p>
        ) : (
          <ol className={styles.rows} style={{ height: rows.length * rowH }}>
            {rows.map((f, i) => (
              <Row
                key={f.id}
                feed={f}
                index={i}
                rowH={rowH}
                expanded={expanded}
                slot={slotOf.get(f.id)}
                upcoming={upcomingFor.get(f.id)}
                stale={!props.connected || f.intensityStale}
                hot={(f.intensity?.score ?? 0) >= props.hotThreshold}
                onPromote={props.onPromote}
              />
            ))}
          </ol>
        )}
      </div>

      {otherLive > 0 && (
        <footer className={styles.foot}>
          <Link to="/settings/sports" className={styles.footLink}>
            +{otherLive} live in other sports
          </Link>
        </footer>
      )}
    </section>
  );
}

const Row = memo(function Row({
  feed: f,
  index,
  rowH,
  expanded,
  slot,
  upcoming,
  stale,
  hot,
  onPromote,
}: {
  feed: FeedState;
  index: number;
  rowH: number;
  expanded: boolean;
  slot: SlotId | undefined;
  upcoming: UpcomingSwitch | undefined;
  stale: boolean;
  hot: boolean;
  onPromote: (feedId: string) => void;
}) {
  const trail = useIntensityTrail(f.id, f.runId);
  const seconds = expanded ? 60 : 40;
  const points = useMemo(() => windowed(trail, seconds + 2), [trail, seconds]);
  const delta = trendOf(trail, 30);
  const score = f.intensity ? Math.round(f.intensity.score) : null;
  const competition = getCompetition(f.event.competitionId)?.name;
  const channel = f.event.broadcaster?.channel ?? f.event.broadcaster?.name;
  const isMain = slot === 'main';
  const style = { transform: `translateY(${index * rowH}px)`, height: rowH } as CSSProperties;

  return (
    <li className={styles.rowWrap} style={style}>
      <button
        type="button"
        className={`${styles.row} ${slot ? styles.onScreen : ''} ${isMain ? styles.inMain : ''} ${upcoming ? styles.next : ''}`}
        onClick={() => onPromote(f.id)}
        disabled={isMain}
        aria-label={`${f.event.title}${score !== null ? `, intensity ${score}` : ''}${slot ? `, in ${SLOT_LABEL[slot]}` : ''}${isMain ? '' : '. Watch in the main window'}`}
      >
        <span className={styles.pip} aria-hidden title={slot ? `On ${SLOT_LABEL[slot]}` : undefined}>
          {slot ? screenNumber(slot) : ''}
        </span>
        <SportIcon sportId={f.sportId} size={14} strokeWidth={2.1} className={styles.sport} />
        <span className={styles.titles}>
          <span className={styles.title}>{f.event.title}</span>
          {expanded && (
            <span className={styles.sub}>
              {[channel, competition].filter(Boolean).join(' · ') || f.event.subtitle}
            </span>
          )}
        </span>
        {upcoming ? (
          <span className={styles.nextTag}>
            <ArrowRightLeft size={11} strokeWidth={2.5} /> Next
          </span>
        ) : expanded && delta !== null && Math.abs(delta) >= 4 ? (
          <span className={`${styles.delta} mono ${delta > 0 ? styles.up : styles.down}`}>
            {delta > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {delta > 0 ? '+' : ''}
            {Math.round(delta)}
          </span>
        ) : null}
        <TrendLine
          points={points}
          seconds={seconds}
          width={expanded ? 72 : 44}
          height={expanded ? 24 : 16}
          hot={hot && !stale}
          className={`${styles.trend} ${hot && !stale ? styles.trendHot : ''}`}
        />
        <span className={`${styles.score} mono ${hot && !stale ? styles.scoreHot : ''} ${stale ? styles.stale : ''}`}>
          {score ?? '–'}
        </span>
      </button>
    </li>
  );
});

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { DEFAULT_HIGHLIGHT_CONFIG, getCompetition, getSport, matchesFollows, type Highlight } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { apiUrl, mediaUrl } from '../../lib/env';
import { formatDuration, formatTimeOfDay } from '../../lib/format';
import { useHighlights } from '../../lib/highlights';
import { useLive } from '../../lib/live-client';
import { usePreferences } from '../../lib/preferences';
import { ClipPlayer } from './ClipPlayer';
import { IntensityCurve } from './IntensityCurve';
import styles from './HighlightViewer.module.scss';

/** A larger player for one highlight, with the rest of today's moments alongside for exploring. */
export function HighlightViewer() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { highlights, timezone, status } = useHighlights();
  const { prefs } = usePreferences();
  const { config } = useLive();
  const [fetched, setFetched] = useState<Highlight | null>(null);
  const [position, setPosition] = useState(0);
  const activeRef = useRef<HTMLAnchorElement>(null);

  const list = useMemo(() => {
    const mine = highlights.filter((h) => matchesFollows(h, prefs.follows));
    return mine.length ? mine : highlights;
  }, [highlights, prefs.follows]);
  const current = highlights.find((h) => h.id === id) ?? (fetched?.id === id ? fetched : undefined);

  // Deep link to a highlight outside today's list (e.g. yesterday): fetch it directly.
  useEffect(() => {
    if (!id || current || status === 'loading') return;
    const ctrl = new AbortController();
    fetch(apiUrl(`/api/highlights/${id}`), { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((h: Highlight | null) => setFetched(h))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [id, current, status]);

  const index = list.findIndex((h) => h.id === id);
  const go = useCallback(
    (delta: number) => {
      if (!list.length) return;
      const next = list[(Math.max(0, index) + delta + list.length) % list.length];
      if (next) navigate(`/best/${next.id}`, { replace: true });
    },
    [list, index, navigate],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/best');
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, navigate]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [id]);

  const onPosition = useCallback((p: number) => setPosition(p), []);

  if (!current) {
    return (
      <main className={styles.missing}>
        <p>{status === 'loading' ? 'Loading…' : 'This highlight is no longer available.'}</p>
        <Link to="/best" className="sl-link">
          Back to Best of Today
        </Link>
      </main>
    );
  }

  const competition = getCompetition(current.event.competitionId);
  return (
    <main className={styles.page}>
      <section className={styles.stage} aria-label="Highlight player">
        <div className={styles.toolbar}>
          <Link to="/best" className={styles.close} aria-label="Close and return to Best of Today">
            <X size={18} />
          </Link>
          <span className={styles.counter}>{index >= 0 ? `${index + 1} of ${list.length}` : ''}</span>
          <button type="button" className={styles.nav} onClick={() => go(-1)} aria-label="Previous highlight">
            <ChevronLeft size={18} />
          </button>
          <button type="button" className={styles.nav} onClick={() => go(1)} aria-label="Next highlight">
            <ChevronRight size={18} />
          </button>
        </div>
        <ClipPlayer highlight={current} onPosition={onPosition} />
        <div className={styles.info}>
          <div className={styles.infoMain}>
            <p className={styles.sport}>
              <SportIcon sportId={current.sportId} size={14} strokeWidth={2.25} />
              {getSport(current.sportId)?.name}
              {competition && <span> · {competition.name}</span>}
            </p>
            <h1 className={styles.title}>{current.event.title}</h1>
            {current.event.subtitle && <p className={styles.subtitle}>{current.event.subtitle}</p>}
          </div>
          <dl className={styles.stats}>
            <div>
              <dt>Peak</dt>
              <dd className={`mono ${styles.peak}`}>{Math.round(current.peak.score)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd className="mono">{formatTimeOfDay(current.peak.at, timezone ?? undefined)}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd className="mono">{formatDuration(current.clip.durationSec)}</dd>
            </div>
          </dl>
        </div>
        <IntensityCurve
          highlight={current}
          position={position}
          threshold={config?.highlights.enterThreshold ?? DEFAULT_HIGHLIGHT_CONFIG.enterThreshold}
        />
      </section>

      <aside className={styles.rail} aria-label="More highlights">
        <h2 className={styles.railTitle}>More from today</h2>
        <ol className={styles.list}>
          {list.map((h) => (
            <li key={h.id}>
              <Link
                ref={h.id === id ? activeRef : undefined}
                to={`/best/${h.id}`}
                replace
                className={`${styles.item} ${h.id === id ? styles.itemActive : ''}`}
                aria-current={h.id === id ? 'true' : undefined}
              >
                <span className={styles.itemThumb}>
                  {h.thumbnailUrl && <img src={mediaUrl(h.thumbnailUrl)} alt="" loading="lazy" />}
                  <span className={`${styles.itemDur} mono`}>{formatDuration(h.clip.durationSec)}</span>
                </span>
                <span className={styles.itemMeta}>
                  <span className={styles.itemTitle}>{h.event.title}</span>
                  <span className={styles.itemSub}>
                    <SportIcon sportId={h.sportId} size={12} strokeWidth={2.25} />
                    <span className="mono">{formatTimeOfDay(h.peak.at, timezone ?? undefined)}</span>
                  </span>
                </span>
                <span className={`${styles.itemPeak} mono`}>{Math.round(h.peak.score)}</span>
              </Link>
            </li>
          ))}
        </ol>
      </aside>
    </main>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { matchesFollows } from '@sportlight/shared';
import { useHighlights } from '../lib/highlights';
import { useNow, useReducedMotion } from '../lib/hooks';
import { useLive } from '../lib/live-client';
import { formatClock } from '../lib/format';
import { usePreferences } from '../lib/preferences';
import { Logo } from './Logo';
import { SportIcon } from './SportIcon';
import styles from './Header.module.scss';

export function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Link to="/" className={styles.brand} aria-label="Sportlight live">
          <Logo height={24} />
        </Link>
        <LiveIndicator />
      </div>
      <nav className={styles.right} aria-label="Main">
        <BestOfTodayLink />
        <NavLink
          to="/settings"
          className={({ isActive }) => `${styles.iconLink} ${isActive ? styles.active : ''}`}
          aria-label="Settings"
        >
          <Settings size={18} />
        </NavLink>
      </nav>
    </header>
  );
}

function LiveIndicator() {
  const { status, ready, clockOffsetMs } = useLive();
  const now = useNow(1000);
  const online = status === 'open';
  return (
    <NavLink to="/" end className={({ isActive }) => `${styles.live} ${isActive ? styles.active : ''}`}>
      <span className={`${styles.dot} ${online ? styles.dotLive : styles.dotOff}`} aria-hidden />
      <span>{online ? 'Live' : ready ? 'Reconnecting…' : 'Connecting…'}</span>
      <span className={`${styles.clock} mono`} aria-hidden>
        {formatClock(now + clockOffsetMs)}
      </span>
      <span className="sr-only" role="status">
        {online ? '' : 'Connection lost. Reconnecting.'}
      </span>
    </NavLink>
  );
}

/**
 * "Best of Today" with the sports of today's top moments as icons and a slowly rotating preview tag
 * of the best clips (static under reduced motion).
 */
function BestOfTodayLink() {
  const { highlights } = useHighlights();
  const { prefs } = usePreferences();
  const reduced = useReducedMotion();
  const top = useMemo(() => {
    const mine = highlights.filter((h) => matchesFollows(h, prefs.follows));
    return (mine.length ? mine : highlights).slice(0, 5);
  }, [highlights, prefs.follows]);
  const icons = useMemo(() => [...new Set(top.map((h) => h.sportId))].slice(0, 3), [top]);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (reduced || top.length < 2) return;
    const t = window.setInterval(() => setI((n) => n + 1), 6000);
    return () => clearInterval(t);
  }, [reduced, top.length]);

  const tag = top.length ? top[i % top.length] : undefined;
  return (
    <NavLink to="/best" className={({ isActive }) => `${styles.best} ${isActive ? styles.active : ''}`}>
      {icons.length > 0 && (
        <span className={styles.icons} aria-hidden>
          {icons.map((s) => (
            <SportIcon key={s} sportId={s} size={15} strokeWidth={2} />
          ))}
        </span>
      )}
      <span className={styles.bestLabel}>Best of Today</span>
      {tag && (
        <span key={tag.id} className={styles.tag} aria-hidden>
          <span className={styles.tagTitle}>{tag.event.title}</span>
          <span className="mono">{Math.round(tag.peak.score)}</span>
        </span>
      )}
    </NavLink>
  );
}

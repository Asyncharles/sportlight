import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { SPORTS, type SportId } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { useLive } from '../../lib/live-client';
import { usePreferences } from '../../lib/preferences';
import base from './Settings.module.scss';
import styles from './SportsSettings.module.scss';

/** Its own settings view: one row per sport with live count and an on/off switch. */
export function SportsSettings() {
  const { sports, setSports } = usePreferences();
  const { feeds } = useLive();
  const live = useMemo(() => {
    const n: Partial<Record<SportId, number>> = {};
    for (const f of Object.values(feeds)) if (f.status === 'live') n[f.sportId] = (n[f.sportId] ?? 0) + 1;
    return n;
  }, [feeds]);
  const toggle = (id: SportId) => setSports(sports.includes(id) ? sports.filter((s) => s !== id) : [...sports, id]);
  const allOn = sports.length === SPORTS.length;

  return (
    <main className={base.page}>
      <Link to="/settings" className={styles.back}>
        <ChevronLeft size={16} /> Settings
      </Link>
      <div className={styles.head}>
        <h1 className={base.title}>Your sports</h1>
        <button
          type="button"
          className="sl-button small secondary"
          onClick={() => setSports(allOn ? [] : SPORTS.map((s) => s.id))}
        >
          {allOn ? 'Clear all' : 'Select all'}
        </button>
      </div>
      <p className={base.hint}>
        {sports.length} of {SPORTS.length} selected · changes apply immediately
      </p>

      <ul className={styles.list} role="group" aria-label="Sports">
        {SPORTS.map((sport) => {
          const on = sports.includes(sport.id);
          const count = live[sport.id] ?? 0;
          return (
            <li key={sport.id}>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                className={`${styles.item} ${on ? styles.on : ''}`}
                onClick={() => toggle(sport.id)}
              >
                <span className={styles.icon}>
                  <SportIcon sportId={sport.id} size={20} strokeWidth={1.75} />
                </span>
                <span className={styles.name}>{sport.name}</span>
                <span className={`${styles.count} ${count ? styles.isLive : ''}`}>
                  {count > 0 ? `${count} live` : 'Not live'}
                </span>
                <span className={styles.switch} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      {sports.length === 0 && <p className={base.warn}>Select at least one sport to see live feeds.</p>}
    </main>
  );
}

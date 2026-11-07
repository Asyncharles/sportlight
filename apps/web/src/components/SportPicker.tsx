import { Check } from 'lucide-react';
import { SPORTS, type FeedState, type SportId } from '@sportlight/shared';
import { SportIcon } from './SportIcon';
import styles from './SportPicker.module.scss';

/** Multi-select grid of sports with live counts. Toggle buttons use aria-pressed. */
export function SportPicker({
  selected,
  onChange,
  feeds,
}: {
  selected: SportId[];
  onChange: (ids: SportId[]) => void;
  feeds?: readonly FeedState[];
}) {
  const liveCount = (id: SportId) => feeds?.filter((f) => f.sportId === id && f.status === 'live').length ?? 0;
  const toggle = (id: SportId) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className={styles.grid} role="group" aria-label="Sports">
      {SPORTS.map((sport) => {
        const on = selected.includes(sport.id);
        const count = liveCount(sport.id);
        return (
          <button
            key={sport.id}
            type="button"
            className={`${styles.card} ${on ? styles.on : ''}`}
            aria-pressed={on}
            onClick={() => toggle(sport.id)}
          >
            <span className={styles.icon}>
              <SportIcon sportId={sport.id} size={22} strokeWidth={1.75} />
            </span>
            <span className={styles.name}>{sport.name}</span>
            {feeds && <span className={styles.count}>{count > 0 ? `${count} live` : 'Not live'}</span>}
            <span className={styles.check} aria-hidden>
              <Check size={14} strokeWidth={3} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

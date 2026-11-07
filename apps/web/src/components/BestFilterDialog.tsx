import { useEffect, useMemo, useRef } from 'react';
import { Check, X } from 'lucide-react';
import { SPORTS, type SportId } from '@sportlight/shared';
import { useBestUi } from '../lib/best-ui';
import { useHighlights } from '../lib/highlights';
import { usePreferences } from '../lib/preferences';
import { SportIcon } from './SportIcon';
import styles from './BestFilterDialog.module.scss';

/**
 * Modal filter for Best of Today: pick which sports' moments to show. Changes apply as you tick;
 * "Reset" goes back to following your sports.
 */
export function BestFilterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { highlights } = useHighlights();
  const { sports: followed } = usePreferences();
  const { sports, setSports } = useBestUi();
  const selected: SportId[] = sports ?? followed;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const counts = useMemo(() => {
    const n: Partial<Record<SportId, number>> = {};
    for (const h of highlights) n[h.sportId] = (n[h.sportId] ?? 0) + 1;
    return n;
  }, [highlights]);

  // Sports with moments today first, then the rest; alphabetical within each group.
  const ordered = useMemo(
    () => [...SPORTS].sort((a, b) => Number(!counts[a.id]) - Number(!counts[b.id]) || a.name.localeCompare(b.name)),
    [counts],
  );

  const toggle = (id: SportId) =>
    setSports(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const allOn = selected.length === SPORTS.length;
  const shown = highlights.filter((h) => selected.includes(h.sportId)).length;

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="best-filter-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 id="best-filter-title">Filter highlights</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <div className={styles.sectionHead}>
          <span>Sports</span>
          <button type="button" className={styles.textButton} onClick={() => setSports(allOn ? [] : SPORTS.map((s) => s.id))}>
            {allOn ? 'Clear all' : 'Select all'}
          </button>
        </div>

        <ul className={styles.list} role="group" aria-label="Sports">
          {ordered.map((sport) => {
            const on = selected.includes(sport.id);
            const count = counts[sport.id] ?? 0;
            return (
              <li key={sport.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={`${styles.item} ${on ? styles.on : ''}`}
                  onClick={() => toggle(sport.id)}
                >
                  <span className={styles.box} aria-hidden>
                    {on && <Check size={13} strokeWidth={3} />}
                  </span>
                  <SportIcon sportId={sport.id} size={16} strokeWidth={1.9} className={styles.icon} />
                  <span className={styles.name}>{sport.name}</span>
                  <span className={`${styles.count} mono`}>{count || '–'}</span>
                </button>
              </li>
            );
          })}
        </ul>

        <footer className={styles.foot}>
          <button type="button" className={styles.textButton} onClick={() => setSports(null)} disabled={sports === null}>
            Reset to your sports
          </button>
          <button type="button" className="sl-button small" onClick={onClose}>
            Show {shown} {shown === 1 ? 'moment' : 'moments'}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

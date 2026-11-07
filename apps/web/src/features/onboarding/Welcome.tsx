import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { SPORTS } from '@sportlight/shared';
import { Logo } from '../../components/Logo';
import { SportPicker } from '../../components/SportPicker';
import { useLive } from '../../lib/live-client';
import { usePreferences } from '../../lib/preferences';
import { WindowsIllustration } from './WindowsIllustration';
import styles from './Welcome.module.scss';

export function Welcome() {
  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <Logo height={24} />
      </header>
      <main className={styles.hero}>
        <h1 className={styles.title}>Welcome to Sportlight</h1>
        <p className={styles.tagline}>The moment is now.</p>
        <div className={styles.illustration}>
          <WindowsIllustration />
        </div>
        <p className={styles.lede}>
          We watch every live feed and bring the most intense moments in your sports to the front — one main window,
          three more alongside.
        </p>
        <Link to="/welcome/sports" className={`sl-button ${styles.cta}`}>
          Choose your sports <ArrowRight size={18} />
        </Link>
      </main>
    </div>
  );
}

export function ChooseSports() {
  const { sports, setSports, update } = usePreferences();
  const { feeds } = useLive();
  const feedList = useMemo(() => Object.values(feeds), [feeds]);
  const [selected, setSelected] = useState<string[]>(sports);
  const navigate = useNavigate();

  const finish = () => {
    setSports(selected);
    update({ onboarded: true });
    navigate('/', { replace: true });
  };

  const allSelected = selected.length === SPORTS.length;

  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <Link to="/welcome" className={styles.back} aria-label="Back">
          <ArrowLeft size={18} />
        </Link>
        <Logo height={24} />
      </header>
      <main className={styles.choose}>
        <div className={styles.chooseHead}>
          <div>
            <h1 className={styles.chooseTitle}>Choose your sports</h1>
            <p className={styles.chooseText}>Pick as many as you like. You can change this any time in settings.</p>
          </div>
          <button
            type="button"
            className="sl-button small secondary"
            onClick={() => setSelected(allSelected ? [] : SPORTS.map((s) => s.id))}
          >
            {allSelected ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <SportPicker selected={selected} onChange={setSelected} feeds={feedList} />
        <div className={styles.footer}>
          <span className={styles.count} aria-live="polite">
            {selected.length === 0 ? 'Select at least one sport' : `${selected.length} selected`}
          </span>
          <button type="button" className="sl-button" disabled={selected.length === 0} onClick={finish}>
            Start watching <ArrowRight size={18} />
          </button>
        </div>
      </main>
    </div>
  );
}

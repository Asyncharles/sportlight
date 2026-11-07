import { useEffect, useState } from 'react';
import { SPORTS } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { useReducedMotion } from '../../lib/hooks';
import styles from './WindowsIllustration.module.scss';

const SEQUENCE = ['football', 'motorsport', 'tennis', 'ice-hockey', 'basketball', 'cycling', 'esports', 'rugby'];
const SCORES = [92, 74, 81, 67, 88, 71, 79, 84];
const STEP_MS = 2200;

/**
 * Welcome illustration of the windowed experience: one main window and side windows whose feeds
 * pop in and out as intensity shifts. Static under reduced motion.
 */
export function WindowsIllustration() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const t = window.setInterval(() => setStep((s) => s + 1), STEP_MS);
    return () => clearInterval(t);
  }, [reduced]);

  // Side windows change alternately; the main window holds steady (it is the viewer's choice).
  const top = SEQUENCE[(1 + 2 * Math.floor((step + 1) / 2)) % SEQUENCE.length]!;
  const bottom = SEQUENCE[(2 + 2 * Math.floor(step / 2)) % SEQUENCE.length]!;
  const scoreOf = (s: string) => SCORES[SEQUENCE.indexOf(s)] ?? 70;

  return (
    <div className={styles.wrap} aria-hidden>
      <Window big sport="football" score={step % 3 === 2 ? 96 : 92} />
      <div className={styles.column}>
        <Window sport={top} score={scoreOf(top)} />
        <Window sport={bottom} score={scoreOf(bottom)} />
      </div>
    </div>
  );
}

function Window({ sport, score, big }: { sport: string; score: number; big?: boolean }) {
  const name = SPORTS.find((s) => s.id === sport)?.name ?? sport;
  return (
    <div className={`${styles.window} ${big ? styles.big : ''}`}>
      <div key={sport} className={styles.content}>
        <div className={styles.field} data-sport={sport} />
        <span className={styles.icon}>
          <SportIcon sportId={sport} size={big ? 26 : 18} strokeWidth={1.75} />
        </span>
        {big && <span className={styles.name}>{name}</span>}
        <span className={`${styles.score} ${score >= 85 ? styles.hot : ''} mono`}>{score}</span>
        <span className={styles.meter}>
          <span style={{ transform: `scaleX(${score / 100})` }} />
        </span>
      </div>
    </div>
  );
}

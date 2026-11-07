import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Hand, ListFilter, Sparkles, Zap } from 'lucide-react';
import { DEFAULT_SELECTION_CONFIG, SPORTS } from '@sportlight/shared';
import { Logo } from '../../components/Logo';
import { SportIcon } from '../../components/SportIcon';
import { useLive } from '../../lib/live-client';
import { usePreferences } from '../../lib/preferences';
import { WindowsIllustration } from './WindowsIllustration';
import styles from './Landing.module.scss';

/** Public landing page at the base URL. Choosing sports happens in the tour on first visit to /live. */
export function Landing() {
  const { prefs } = usePreferences();
  const { feeds } = useLive();
  const feedList = useMemo(() => Object.values(feeds), [feeds]);
  const rules = DEFAULT_SELECTION_CONFIG;

  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <Link to="/" className={styles.brand} aria-label="Sportlight home" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <Logo height={24} />
        </Link>
        <nav className={styles.topNav} aria-label="Landing">
          <a href="#how" className={styles.topLink}>
            How it works
          </a>
          <Link to="/live" className="sl-button small">
            {prefs.onboarded ? 'Open live' : 'Watch live'}
          </Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <h1 className={styles.title}>
              The moment is <em>now.</em>
            </h1>
            <p className={styles.lede}>
              Sportlight watches every live game at once and puts the most intense moments in your sports on screen —
              the instant they happen.
            </p>
            <Link to="/live" className={`sl-button ${styles.cta}`}>
              {prefs.onboarded ? 'Back to live' : 'Start watching'} <ArrowRight size={18} />
            </Link>
          </div>
          <div className={styles.heroStage}>
            <WindowsIllustration feeds={feedList} />
          </div>
        </section>

        <section id="how" className={styles.how} aria-labelledby="how-title">
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}>How it works</span>
            <h2 id="how-title" className={styles.sectionTitle}>
              You pick the sports. We find the moments.
            </h2>
          </div>

          <ol className={styles.steps}>
            <Step
              n={1}
              icon={<Activity size={18} />}
              title="Every feed, scored live"
              text="Each stream carries an intensity score from 0 to 100, updated every second — a goal-mouth scramble, a last-lap overtake, a match point."
              visual={<SparkVisual />}
            />
            <Step
              n={2}
              icon={<ListFilter size={18} />}
              title="Only your sports"
              text="Your selection decides what's eligible. Nothing outside it ever takes a window — on the live page or in highlights."
              visual={<FilterVisual />}
            />
            <Step
              n={3}
              icon={<Zap size={18} />}
              title="Big moments earn a window"
              text={`A challenger must beat the quietest side window by ${rules.replaceMargin} points for ${rules.challengeMs / 1000} seconds. Every feed stays at least ${rules.minDisplayMs / 1000} seconds, so nothing jitters.`}
              visual={
                <RuleVisual
                  rules={[
                    [`+${rules.replaceMargin}`, 'to challenge'],
                    [`${rules.challengeMs / 1000}s`, 'sustained'],
                    [`${rules.minDisplayMs / 1000}s`, 'on screen'],
                  ]}
                />
              }
            />
            <Step
              n={4}
              icon={<Sparkles size={18} />}
              title="Missed it? Best of Today"
              text="Every peak is clipped automatically into a highlights wall — the bigger the moment, the bigger the tile."
              visual={<BestVisual />}
            />
          </ol>

          <div className={styles.control}>
            <Hand size={18} />
            <p>
              <strong>You're always in control.</strong> Click any window to make it the main one, vote moments up or
              down, and tune how eagerly feeds switch in settings.
            </p>
          </div>
        </section>

        <section className={styles.closing}>
          <h2 className={styles.closingTitle}>Ready when the action is.</h2>
          <p className={styles.closingText}>Pick your sports when you arrive and you're watching. No account needed.</p>
          <Link to="/live" className={`sl-button ${styles.cta}`}>
            {prefs.onboarded ? 'Back to live' : 'Start watching'} <ArrowRight size={18} />
          </Link>
        </section>
      </main>
    </div>
  );
}

function Step({ n, icon, title, text, visual }: { n: number; icon: ReactNode; title: string; text: string; visual: ReactNode }) {
  return (
    <li className={styles.step}>
      <div className={styles.stepVisual} aria-hidden>
        {visual}
      </div>
      <div className={styles.stepHead}>
        <span className={styles.stepIcon}>{icon}</span>
        <span className={`${styles.stepNum} mono`}>0{n}</span>
      </div>
      <h3 className={styles.stepTitle}>{title}</h3>
      <p className={styles.stepText}>{text}</p>
    </li>
  );
}

function SparkVisual() {
  const pts = [38, 42, 40, 47, 44, 52, 49, 58, 55, 63, 60, 71, 86, 93, 81, 66, 61, 64, 58];
  const w = 220;
  const h = 72;
  const x = (i: number) => (i / (pts.length - 1)) * w;
  const y = (v: number) => h - 6 - ((v - 30) / 70) * (h - 12);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const peak = pts.indexOf(Math.max(...pts));
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={styles.spark} preserveAspectRatio="none">
      <line x1="0" x2={w} y1={y(85)} y2={y(85)} className={styles.sparkThreshold} />
      <path d={`${line} L${w},${h} L0,${h} Z`} className={styles.sparkArea} />
      <path d={line} className={styles.sparkLine} />
      <circle cx={x(peak)} cy={y(pts[peak]!)} r="4.5" className={styles.sparkPeak} />
    </svg>
  );
}

function FilterVisual() {
  const on = new Set(['football', 'tennis', 'motorsport']);
  return (
    <div className={styles.chips}>
      {SPORTS.slice(0, 8).map((s) => (
        <span key={s.id} className={styles.chip} data-on={on.has(s.id)}>
          <SportIcon sportId={s.id} size={13} strokeWidth={2} />
        </span>
      ))}
    </div>
  );
}

function RuleVisual({ rules }: { rules: [string, string][] }) {
  return (
    <div className={styles.rules}>
      {rules.map(([v, l]) => (
        <span key={l} className={styles.rule}>
          <strong className="mono">{v}</strong>
          <span>{l}</span>
        </span>
      ))}
    </div>
  );
}

function BestVisual() {
  return (
    <div className={styles.best}>
      <span data-size="l" />
      <span />
      <span />
      <span data-size="w" />
    </div>
  );
}

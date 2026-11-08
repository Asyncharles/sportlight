import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, Crosshair, Zap } from 'lucide-react';
import { SPORTS, type FeedState, type MainPolicy, type SportId } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { useLive } from '../../lib/live-client';
import { usePreferences } from '../../lib/preferences';
import { useMediaCatalog } from '../../lib/media-catalog';
import { sportLiveStats, sportMedia } from '../../lib/sport-media';
import styles from './LiveTour.module.scss';

/**
 * First-visit tour on the live page. A short setup dialog (sports, then main-window behaviour),
 * followed by coachmarks over the controls. Elements opt in with `data-tour="<id>"`; stops whose
 * target isn't on screen are skipped. Finishing (or skipping) marks the viewer as onboarded.
 */

interface Stop {
  id: string;
  /** CSS selectors, first visible match wins. */
  target: string[];
  title: string;
  text: string;
}

const STOPS: Stop[] = [
  {
    id: 'main',
    target: ['[data-slot="main"]', '[data-tour="stage"]'],
    title: 'The action comes to you',
    text: 'The big window is your main feed. Side windows fill with the most intense moments in your sports — click one to make it the main window.',
  },
  {
    id: 'view',
    target: ['[data-tour="view"]'],
    title: 'Pick a layout',
    text: 'Switch between Theatre, Classic, Quad and a detailed table of every feed.',
  },
  {
    id: 'lock',
    target: ['[data-tour="lock"]'],
    title: 'Hold still',
    text: 'Lock freezes the windows so nothing switches automatically. Press L to toggle it.',
  },
  {
    id: 'best',
    target: ['[data-tour="best"]'],
    title: 'Missed something?',
    text: 'Every peak is clipped into Best of Today — the bigger the moment the bigger the tile.',
  },
  {
    id: 'settings',
    target: ['[data-tour="settings"]'],
    title: 'Make it yours',
    text: 'Change your sports, switching pace and appearance in settings any time.',
  },
];

type Phase = 'sports' | 'feel' | number;

export function LiveTour() {
  const { prefs, update } = usePreferences();
  const [phase, setPhase] = useState<Phase>('sports');
  if (prefs.onboarded) return null;

  const finish = () => update({ onboarded: true });

  if (phase === 'sports' || phase === 'feel') {
    return (
      <SetupDialog
        phase={phase}
        onNext={() => (phase === 'sports' ? setPhase('feel') : setPhase(0))}
        onBack={() => setPhase('sports')}
        onSkip={finish}
      />
    );
  }
  return <Coachmarks index={phase} onIndex={setPhase} onDone={finish} />;
}

// ================================================================ setup dialog

function SetupDialog({
  phase,
  onNext,
  onBack,
  onSkip,
}: {
  phase: 'sports' | 'feel';
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { sports, setSports, prefs, updateLive } = usePreferences();
  const { feeds } = useLive();
  const feedList = useMemo(() => Object.values(feeds), [feeds]);
  const [selected, setSelected] = useState<SportId[]>(sports);
  const [policy, setPolicy] = useState<MainPolicy>(prefs.live.mainPolicy);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const step = phase === 'sports' ? 1 : 2;
  const next = () => {
    if (phase === 'sports') setSports(selected);
    else updateLive({ mainPolicy: policy });
    onNext();
  };

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="tour-title"
      // A choice is needed before watching: Escape doesn't dismiss the first step.
      onCancel={(e) => {
        e.preventDefault();
        if (phase === 'feel') onSkip();
      }}
    >
      <div className={styles.panel}>
        {phase === 'sports' ? (
          <SportsStep feeds={feedList} selected={selected} onChange={setSelected} />
        ) : (
          <FeelStep policy={policy} onChange={setPolicy} />
        )}
        <footer className={styles.foot}>
          {phase === 'sports' ? (
            <SportsSummary feeds={feedList} selected={selected} />
          ) : (
            <span className={`${styles.summary} ${styles.summaryMuted}`}>You can change this later in settings.</span>
          )}
          <div className={styles.footActions}>
            <span className={`${styles.summaryMuted} mono`} aria-label={`Step ${step} of 2`}>
              {step} / 2
            </span>
            {phase === 'feel' && (
              <button type="button" className="sl-button small secondary" onClick={onBack}>
                Back
              </button>
            )}
            <button
              type="button"
              className="sl-button small"
              disabled={phase === 'sports' && selected.length === 0}
              onClick={next}
            >
              {phase === 'sports' ? 'Continue' : 'Show me around'} <ArrowRight size={16} />
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}

function SportsStep({
  feeds,
  selected,
  onChange,
}: {
  feeds: FeedState[];
  selected: SportId[];
  onChange: (ids: SportId[]) => void;
}) {
  useMediaCatalog(); // tile imagery; re-renders when the catalog arrives
  const toggle = (id: SportId) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const allSelected = selected.length === SPORTS.length;

  // Live sports first; order once on the first snapshot so tiles don't reshuffle under the cursor.
  const ordered = useMemo(
    () => [...SPORTS].sort((a, b) => sportLiveStats(b.id, feeds).live - sportLiveStats(a.id, feeds).live),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feeds.length > 0],
  );

  return (
    <>
      <header className={styles.head}>
        <div>
          <span className={styles.kicker}>Welcome to Sportlight</span>
          <h2 id="tour-title" className={styles.title}>
            What do you want to watch?
          </h2>
          <p className={styles.text}>Only feeds from these sports will take a window. Pick as many as you like.</p>
        </div>
        <button
          type="button"
          className="sl-button small secondary"
          onClick={() => onChange(allSelected ? [] : SPORTS.map((s) => s.id))}
        >
          {allSelected ? 'Clear all' : 'Select all'}
        </button>
      </header>
      <div className={styles.body}>
        <div className={styles.tiles} role="group" aria-label="Sports">
          {ordered.map((sport, i) => {
            const on = selected.includes(sport.id);
            const stats = sportLiveStats(sport.id, feeds);
            const media = sportMedia(sport.id, feeds);
            return (
              <button
                key={sport.id}
                type="button"
                className={styles.tile}
                aria-pressed={on}
                aria-label={`${sport.name}, ${stats.live > 0 ? `${stats.live} live` : 'not live now'}`}
                onClick={() => toggle(sport.id)}
                style={{ animationDelay: `${i * 25}ms` }}
              >
                {media.poster && <img src={media.poster} alt="" className={styles.tileImg} draggable={false} />}
                <span className={styles.tileStatus}>
                  {stats.live > 0 ? (
                    <>
                      <span className={styles.liveDot} />
                      {stats.live} live
                      {stats.top !== null && <span className={`${styles.tileScore} mono`}>{stats.top}</span>}
                    </>
                  ) : (
                    'Not live now'
                  )}
                </span>
                <span className={styles.tileCheck} aria-hidden>
                  <Check size={14} strokeWidth={3} />
                </span>
                <span className={styles.tileName}>
                  <SportIcon sportId={sport.id} size={17} strokeWidth={2} />
                  {sport.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function SportsSummary({ feeds, selected }: { feeds: FeedState[]; selected: SportId[] }) {
  const live = feeds.filter((f) => f.status === 'live' && selected.includes(f.sportId)).length;
  return (
    <div className={styles.summary} aria-live="polite">
      {selected.length > 0 && (
        <span className={styles.stack} aria-hidden>
          {selected.slice(0, 5).map((id) => (
            <span key={id}>
              <SportIcon sportId={id} size={13} strokeWidth={2} />
            </span>
          ))}
        </span>
      )}
      <span>
        {selected.length === 0 ? (
          'Select at least one sport'
        ) : (
          <>
            <strong>
              {selected.length} {selected.length === 1 ? 'sport' : 'sports'}
            </strong>
            <span className={styles.summaryMuted}>
              {' '}
              · {live} live {live === 1 ? 'feed' : 'feeds'} now
            </span>
          </>
        )}
      </span>
    </div>
  );
}

function FeelStep({ policy, onChange }: { policy: MainPolicy; onChange: (p: MainPolicy) => void }) {
  return (
    <>
      <header className={styles.head}>
        <div>
          <span className={styles.kicker}>One more thing</span>
          <h2 id="tour-title" className={styles.title}>
            What should the main window do?
          </h2>
          <p className={styles.text}>The side windows always follow the action.</p>
        </div>
      </header>
      <div className={styles.body}>
        <div className={styles.policies} role="radiogroup" aria-label="Main window">
          <PolicyCard
            value="user"
            current={policy}
            onSelect={onChange}
            icon={<Crosshair size={18} />}
            title="Stay on my pick"
            text="Holds what you chose. Big moments appear alongside — promote them with a click."
            badge="Recommended"
          />
          <PolicyCard
            value="follow"
            current={policy}
            onSelect={onChange}
            icon={<Zap size={18} />}
            title="Follow the action"
            text="The most intense feed takes the main window automatically."
          />
        </div>
      </div>
    </>
  );
}

function PolicyCard({
  value,
  current,
  onSelect,
  icon,
  title,
  text,
  badge,
}: {
  value: MainPolicy;
  current: MainPolicy;
  onSelect: (v: MainPolicy) => void;
  icon: ReactNode;
  title: string;
  text: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={value === current}
      className={styles.policy}
      onClick={() => onSelect(value)}
    >
      <span className={styles.policyDiagram} data-policy={value} aria-hidden>
        <span />
        <span />
        <span />
        <span className={styles.policyMain}>{icon}</span>
      </span>
      <span className={styles.policyBody}>
        <span className={styles.policyTitle}>
          {title}
          {badge && <span className={styles.badge}>{badge}</span>}
        </span>
        <span className={styles.policyText}>{text}</span>
      </span>
      <span className={styles.radio} aria-hidden />
    </button>
  );
}

// ================================================================ coachmarks

const PAD = 6;
const SPOT_INSET = 6; // Leave room for the 3px spotlight ring at viewport edges.
const GAP = 12;
const CARD_W = 320;
const CARD_H = 170;

function findTarget(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
  }
  return null;
}

function Coachmarks({ index, onIndex, onDone }: { index: number; onIndex: (i: number) => void; onDone: () => void }) {
  // Only stops whose targets are visible now (e.g. some controls hide on small screens).
  const [stops] = useState(() => STOPS.filter((s) => findTarget(s.target)));
  const stop = stops[index];
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!stop) return;
    const el = findTarget(stop.target);
    if (!el) return;
    const measure = () => setRect(el.getBoundingClientRect());
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [stop]);

  useEffect(() => {
    if (!stop) onDone();
  }, [stop, onDone]);

  useEffect(() => cardRef.current?.focus(), [index]);

  const last = index === stops.length - 1;
  const next = () => (last ? onDone() : onIndex(index + 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!stop || !rect) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Full-window targets (including the empty stage) have no space for outward padding.
  // Clip each edge independently so the entire spotlight ring stays on screen.
  const spotLeft = Math.max(SPOT_INSET, rect.left - PAD);
  const spotTop = Math.max(SPOT_INSET, rect.top - PAD);
  const spot = {
    top: spotTop,
    left: spotLeft,
    width: Math.max(0, Math.min(vw - SPOT_INSET, rect.right + PAD) - spotLeft),
    height: Math.max(0, Math.min(vh - SPOT_INSET, rect.bottom + PAD) - spotTop),
  };
  const width = Math.min(CARD_W, vw - 32);
  const left = Math.min(Math.max(16, rect.left + rect.width / 2 - width / 2), vw - 16 - width);
  let top: number;
  if (rect.height > vh * 0.5) top = Math.min(rect.bottom - CARD_H - 24, vh - CARD_H - 16); // big target: inside it
  else if (rect.bottom + GAP + CARD_H < vh) top = rect.bottom + PAD + GAP;
  else top = Math.max(16, rect.top - PAD - GAP - CARD_H);
  const cardStyle: CSSProperties = { top, left, width };

  // Portalled so it stacks above the sticky header rather than inside the page's stacking context.
  return createPortal(
    <div className={styles.coach} onClick={(e) => e.target === e.currentTarget && next()}>
      <div className={styles.spot} style={spot} aria-hidden />
      <div
        ref={cardRef}
        key={index}
        className={styles.card}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="coach-title"
        aria-describedby="coach-text"
        tabIndex={-1}
      >
        <h2 id="coach-title" className={styles.cardTitle}>
          {stop.title}
        </h2>
        <p id="coach-text" className={styles.cardText}>
          {stop.text}
        </p>
        <div className={styles.cardFoot}>
          <span className={styles.dots} aria-label={`${index + 1} of ${stops.length}`}>
            {stops.map((s, i) => (
              <span key={s.id} data-on={i === index} />
            ))}
          </span>
          <div className={styles.footActions}>
            {!last && (
              <button type="button" className={styles.textButton} onClick={onDone}>
                Skip
              </button>
            )}
            <button type="button" className="sl-button small" onClick={next}>
              {last ? 'Start watching' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

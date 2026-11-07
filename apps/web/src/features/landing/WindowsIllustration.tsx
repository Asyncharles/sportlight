import { useEffect, useMemo, useReducer, useState } from 'react';
import { ArrowUp, Volume2 } from 'lucide-react';
import { getSport, type FeedState } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { useReducedMotion } from '../../lib/hooks';
import { sportMedia } from '../../lib/sport-media';
import styles from './WindowsIllustration.module.scss';

/**
 * Landing illustration: a miniature live page (three side windows, one main) playing the demo
 * clips, acting out the real selection rules — a challenger surges, must beat the quietest side
 * window by 10+ points for a few seconds, then swaps in without reshuffling the other windows.
 * Static (no video, no timeline) under reduced motion.
 */

const TICK_MS = 700;
const CYCLE = 14;
const CHALLENGE_AT = 5;
const CHALLENGE_TICKS = 4;
const SWAP_AT = CHALLENGE_AT + CHALLENGE_TICKS;

const ORDER = ['football', 'tennis', 'motorsport', 'basketball', 'rugby', 'ice-hockey', 'cycling', 'athletics', 'esports'];

interface StageState {
  n: number;
  /** [main, side 1, side 2, side 3] */
  slots: string[];
  pool: string[];
  challenge: { sport: string; slot: number } | null;
  /** Sport that just won a window; scores stay high for a while. */
  hot: string | null;
  swapped: number | null;
}

const initial: StageState = {
  n: 0,
  slots: ORDER.slice(0, 4),
  pool: ORDER.slice(4),
  challenge: null,
  hot: null,
  swapped: null,
};

function baseScore(sport: string, n: number, hot: string | null): number {
  const i = ORDER.indexOf(sport);
  const base = 64 + ((i * 7) % 16) + (sport === hot ? 12 : 0);
  return Math.max(40, Math.min(97, Math.round(base + 5 * Math.sin(n * 0.55 + i * 1.7))));
}

function step(s: StageState): StageState {
  const n = s.n + 1;
  const phase = n % CYCLE;
  if (phase === CHALLENGE_AT) {
    const side = [1, 2, 3].sort((a, b) => baseScore(s.slots[a]!, n, s.hot) - baseScore(s.slots[b]!, n, s.hot));
    return { ...s, n, challenge: { sport: s.pool[0]!, slot: side[0]! }, swapped: null };
  }
  if (phase === SWAP_AT && s.challenge) {
    const { sport, slot } = s.challenge;
    const slots = s.slots.slice();
    const out = slots[slot]!;
    slots[slot] = sport;
    return { n, slots, pool: [...s.pool.slice(1), out], challenge: null, hot: sport, swapped: slot };
  }
  return { ...s, n };
}

export function WindowsIllustration({ feeds = [] }: { feeds?: readonly FeedState[] }) {
  const reduced = useReducedMotion();
  const [s, tick] = useReducer(step, initial);

  useEffect(() => {
    if (reduced) return;
    const t = window.setInterval(tick, TICK_MS);
    return () => clearInterval(t);
  }, [reduced]);

  const phase = s.n % CYCLE;
  const score = (sport: string) => baseScore(sport, s.n, s.hot);
  const challenge = s.challenge;
  const progress = challenge ? Math.min(1, (phase - CHALLENGE_AT + 1) / CHALLENGE_TICKS) : 0;
  const defender = challenge ? score(s.slots[challenge.slot]!) : 0;
  const challengerScore = challenge ? Math.min(97, defender + 12 + Math.round(progress * 6)) : 0;

  // Caption text changes once per phase (not every tick), so it reads calmly instead of flickering.
  const caption = reduced
    ? 'Four windows, filled with the most intense moments in your sports.'
    : challenge
      ? `${name(challenge.sport)} is surging — it has to out-score ${name(s.slots[challenge.slot]!)} to take its window.`
      : s.swapped !== null && phase >= SWAP_AT && phase < CYCLE - 2
        ? `${name(s.slots[s.swapped]!)} takes the window. The rest stay exactly where they are.`
        : 'Scoring every live feed, every second.';

  return (
    <figure className={styles.figure} aria-hidden>
      <div className={styles.stage}>
        <div className={styles.side}>
          {[1, 2, 3].map((slot) => (
            <Window
              key={slot}
              sport={s.slots[slot]!}
              score={score(s.slots[slot]!)}
              feeds={feeds}
              playing={!reduced}
              flash={s.swapped === slot && phase === SWAP_AT % CYCLE}
              challenger={challenge?.slot === slot ? { sport: challenge.sport, score: challengerScore, progress } : null}
            />
          ))}
        </div>
        {/* The main window is the viewer's big game: keep it running hot. */}
        <Window main sport={s.slots[0]!} score={Math.min(96, score(s.slots[0]!) + 22)} feeds={feeds} playing={!reduced} />
      </div>
      <figcaption className={styles.caption}>
        <span className={styles.captionDot} />
        <span key={caption} className={styles.captionText}>
          {caption}
        </span>
      </figcaption>
    </figure>
  );
}

const name = (id: string) => getSport(id)?.name ?? id;

function Window({
  sport,
  score,
  feeds,
  playing,
  main,
  flash,
  challenger,
}: {
  sport: string;
  score: number;
  feeds: readonly FeedState[];
  playing: boolean;
  main?: boolean;
  flash?: boolean;
  challenger?: { sport: string; score: number; progress: number } | null;
}) {
  // Keep the outgoing layer under the incoming one until it has faded in — no blank frames.
  const [layers, setLayers] = useState([sport]);
  useEffect(() => {
    setLayers((l) => (l[l.length - 1] === sport ? l : [...l, sport]));
    const t = window.setTimeout(() => setLayers([sport]), 600);
    return () => clearTimeout(t);
  }, [sport]);

  return (
    <div className={`${styles.window} ${main ? styles.main : ''} ${flash ? styles.flash : ''}`}>
      {layers.map((id) => (
        <Media key={id} sport={id} feeds={feeds} playing={playing} />
      ))}
      <div className={styles.chrome}>
        <span className={styles.label}>
          <SportIcon sportId={sport} size={main ? 16 : 13} strokeWidth={2} />
          <span key={sport} className={styles.labelText}>
            {name(sport)}
          </span>
        </span>
        <span className={`${styles.score} ${score >= 85 ? styles.hot : ''} mono`}>{score}</span>
        {main && (
          <span className={styles.audio}>
            <Volume2 size={14} />
          </span>
        )}
        <span className={styles.meter}>
          <span style={{ transform: `scaleX(${score / 100})` }} />
        </span>
      </div>
      {challenger && (
        <div className={styles.challenger}>
          <ArrowUp size={12} strokeWidth={2.5} />
          <SportIcon sportId={challenger.sport} size={12} strokeWidth={2} />
          <span>{name(challenger.sport)}</span>
          <span className="mono">{challenger.score}</span>
          <span className={styles.challengeBar}>
            <span style={{ transform: `scaleX(${challenger.progress})` }} />
          </span>
        </div>
      )}
    </div>
  );
}

function Media({ sport, feeds, playing }: { sport: string; feeds: readonly FeedState[]; playing: boolean }) {
  // Resolve once per layer so a live snapshot arriving later doesn't restart the clip.
  const media = useMemo(() => sportMedia(sport, feeds), [sport]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={styles.media}>
      {media.poster && <img src={media.poster} alt="" className={styles.poster} draggable={false} />}
      {playing && media.video && (
        <video
          className={styles.video}
          src={media.video}
          poster={media.poster}
          muted
          autoPlay
          playsInline
          preload="auto"
          disablePictureInPicture
          onCanPlay={(e) => e.currentTarget.classList.add(styles.ready!)}
          onEnded={(e) => {
            // Loop back to the start point, not 0 (some clips open on a test card).
            e.currentTarget.currentTime = media.startSec;
            void e.currentTarget.play().catch(() => {});
          }}
        />
      )}
    </div>
  );
}

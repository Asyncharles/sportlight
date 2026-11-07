import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowRight, Pin, SkipForward } from 'lucide-react';
import type { FeedState, UpcomingSwitch } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { mediaUrl } from '../../lib/env';
import styles from './SpatialOverlays.module.scss';

// ── Switch takeover ──────────────────────────────────────────────────────────────────────────

function useCountdown(u: UpcomingSwitch) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const total = Math.max(1, u.at - u.since);
  const elapsed = Math.min(total, Math.max(0, now - u.since));
  return {
    seconds: Math.ceil(Math.max(0, u.at - now) / 1000),
    /** Animation timing that tracks the real countdown even if mounted late. */
    timing: { animationDuration: `${total}ms`, animationDelay: `-${elapsed}ms` } as CSSProperties,
  };
}

/**
 * Fills the screen that is about to change: what's coming in, a big countdown, and big Keep /
 * Switch now buttons. The current picture stays visible, dimmed, behind it.
 */
export function SwitchTakeover({
  upcoming,
  incoming,
  current,
  onKeep,
  onHurry,
}: {
  upcoming: UpcomingSwitch;
  incoming: FeedState;
  current: FeedState | null;
  onKeep: () => void;
  onHurry: () => void;
}) {
  const { seconds, timing } = useCountdown(upcoming);
  const poster = mediaUrl(incoming.source.posterUrl);
  const inScore = incoming.intensity ? Math.round(incoming.intensity.score) : null;
  const curScore = current?.intensity ? Math.round(current.intensity.score) : null;
  return (
    <div
      className={styles.takeover}
      role="alertdialog"
      aria-label={`Switching to ${incoming.event.title} in ${seconds} seconds`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.edge} style={timing} aria-hidden />
      <div className={styles.progress} aria-hidden>
        <i style={timing} />
      </div>
      <div className={styles.body}>
        <div className={styles.count} aria-hidden>
          <span key={seconds}>{seconds}</span>
        </div>
        <div className={styles.next}>
          <span className={styles.kicker}>Switching to</span>
          <div className={styles.card}>
            {poster ? <img src={poster} alt="" /> : <div className={styles.noPoster} />}
            <div>
              <b>
                <SportIcon sportId={incoming.sportId} size={30} strokeWidth={2.25} />
                <span>{incoming.event.title}</span>
              </b>
              <span className={styles.compare}>
                <span>{curScore ?? '–'}</span>
                <ArrowRight size={26} />
                <em>{inScore ?? '–'}</em>
                <small>intensity</small>
              </span>
            </div>
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={onKeep}>
              <Pin size={26} /> Keep this
            </button>
            <button type="button" className={styles.now} onClick={onHurry}>
              <SkipForward size={26} /> Switch now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

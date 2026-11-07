import { useEffect, useState, type CSSProperties } from 'react';
import { Pin, SkipForward } from 'lucide-react';
import type { FeedState, UpcomingSwitch } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { mediaUrl } from '../../lib/env';
import styles from './SwitchWarning.module.scss';

const R = 11;
const C = 2 * Math.PI * R;

/**
 * "Switching to X in 3": shown over the window that is about to change, for the countdown the
 * viewer chose. The ring drains in real time; Keep cancels the switch, Now does it immediately.
 */
export function SwitchWarning({
  upcoming: u,
  incoming,
  compact,
  style,
  onKeep,
  onHurry,
}: {
  upcoming: UpcomingSwitch;
  incoming: FeedState;
  compact: boolean;
  style: CSSProperties;
  onKeep: () => void;
  onHurry: () => void;
}) {
  const total = Math.max(1, u.at - u.since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, u.at - now);
  const seconds = Math.ceil(remaining / 1000);
  const elapsed = Math.min(total, Math.max(0, now - u.since));
  const ringStyle = {
    animationDuration: `${total}ms`,
    animationDelay: `-${elapsed}ms`,
  } as CSSProperties;
  const verb = u.kind === 'promote' ? 'To main' : 'Switching to';
  const poster = mediaUrl(incoming.source.posterUrl);

  return (
    <div className={styles.frame} style={style}>
      <div className={styles.edge} style={ringStyle} aria-hidden />
      <div
        className={`${styles.card} ${compact ? styles.compact : ''}`}
        role="status"
        aria-live="polite"
        aria-label={`${verb} ${incoming.event.title} in ${seconds} seconds`}
      >
        <span className={styles.ring} aria-hidden>
          <svg width={28} height={28} viewBox="0 0 28 28">
            <circle cx={14} cy={14} r={R} className={styles.track} />
            <circle
              cx={14}
              cy={14}
              r={R}
              className={styles.arc}
              style={{ ...ringStyle, strokeDasharray: C, ['--c' as string]: C }}
            />
          </svg>
          <span key={seconds} className={`${styles.num} mono`}>
            {seconds}
          </span>
        </span>
        {!compact && poster && <img className={styles.poster} src={poster} alt="" />}
        <span className={styles.text}>
          <span className={styles.verb}>{verb}</span>
          <span className={styles.title}>
            <SportIcon sportId={incoming.sportId} size={13} strokeWidth={2.25} />
            <span>{incoming.event.title}</span>
          </span>
        </span>
        <button type="button" className={styles.btn} onClick={onKeep} title="Keep this feed" aria-label="Keep the current feed">
          <Pin size={14} />
          {!compact && <span>Keep</span>}
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.now}`}
          onClick={onHurry}
          title="Switch now"
          aria-label="Switch now"
        >
          <SkipForward size={14} />
          {!compact && <span>Now</span>}
        </button>
      </div>
    </div>
  );
}

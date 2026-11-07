import { useEffect, useRef, useState } from 'react';
import type { FeedState } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import type { MonitorId } from './SpatialRoom';
import styles from './SpatialPanels.module.scss';

/** Seconds of 1 Hz samples kept for the ticker's deltas. */
const TAPE_SEC = 60;
const DELTA_SEC = 30;
/** Ticker scroll speed, CSS px per second. */
const TICKER_SPEED = 40;

export interface Tape {
  /** Per feed: last TAPE_SEC scores, oldest first. */
  scores: Map<string, number[]>;
  /** Increments every sample, so consumers re-render once a second. */
  tick: number;
}

/** Samples every live feed's score once a second: the desk's "market data". */
export function useTape(feeds: readonly FeedState[], onSample?: () => void): Tape {
  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const sampleRef = useRef(onSample);
  sampleRef.current = onSample;
  const [scores] = useState(() => new Map<string, number[]>());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const sample = () => {
      const live = feedsRef.current.filter((f) => f.intensity);
      for (const f of live) {
        const s = scores.get(f.id) ?? [];
        s.push(f.intensity!.score);
        if (s.length > TAPE_SEC) s.shift();
        scores.set(f.id, s);
      }
      const ids = new Set(live.map((f) => f.id));
      for (const id of scores.keys()) if (!ids.has(id)) scores.delete(id);
      sampleRef.current?.();
      setTick((t) => t + 1);
    };
    sample();
    const t = window.setInterval(sample, 1000);
    return () => clearInterval(t);
  }, [scores]);
  return { scores, tick };
}

function deltaOf(series: number[] | undefined, sec = DELTA_SEC): number | null {
  if (!series || series.length < 4) return null;
  return series[series.length - 1]! - series[Math.max(0, series.length - 1 - sec)]!;
}

function Delta({ value }: { value: number | null }) {
  const v = value === null ? null : Math.round(value);
  if (!v) return <span className={styles.flat}>{v === null ? '—' : '0'}</span>;
  return (
    <span className={v > 0 ? styles.up : styles.down}>
      {v > 0 ? '+' : '−'}
      {Math.abs(v)}
    </span>
  );
}

export const MONITOR_KEY: Record<MonitorId, string> = {
  main: '1',
  'side-1': '2',
  'side-2': '3',
  'side-3': '4',
};

/**
 * A scrolling market-style ticker of every live feed.
 *
 * Scrolled by a pixel offset in rAF rather than a CSS `-50%` keyframe: when scores change the
 * strip's width changes, and a percentage animation would jump; a pixel offset just keeps going.
 */
export function Ticker({
  feeds,
  tape,
  hotThreshold,
  reducedMotion,
  onPick,
}: {
  feeds: readonly FeedState[];
  tape: Tape;
  hotThreshold: number;
  reducedMotion: boolean;
  onPick: (feedId: string) => void;
}) {
  const run = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  useEffect(() => {
    if (reducedMotion) {
      if (run.current) run.current.style.transform = '';
      return;
    }
    let offset = 0;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(now - last, 100) / 1000;
      last = now;
      const width = first.current?.offsetWidth ?? 0;
      if (!paused.current && width) {
        offset = (offset + dt * TICKER_SPEED) % width;
        run.current!.style.transform = `translate3d(${-offset}px,0,0)`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  const items = [...feeds].sort((a, b) => a.event.title.localeCompare(b.event.title));
  const strip = (copy: number) => (
    <div className={styles.tickerStrip} ref={copy ? undefined : first} aria-hidden={copy ? true : undefined}>
      {items.map((f) => {
        const s = f.intensity ? Math.round(f.intensity.score) : null;
        return (
          <button
            type="button"
            key={f.id}
            tabIndex={copy ? -1 : 0}
            className={s !== null && s >= hotThreshold ? styles.tickHot : styles.tick}
            onClick={() => onPick(f.id)}
          >
            <SportIcon sportId={f.sportId} size={12} strokeWidth={2} />
            <b>{f.event.title}</b>
            <span className={styles.score}>{s ?? '–'}</span>
            <Delta value={deltaOf(tape.scores.get(f.id))} />
          </button>
        );
      })}
    </div>
  );
  return (
    <div
      className={styles.ticker}
      data-reduced-motion={reducedMotion}
      aria-label="Live intensity ticker"
      onPointerEnter={() => (paused.current = true)}
      onPointerLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
    >
      <div className={styles.tickerRun} ref={run}>
        {items.length === 0 && <span className={styles.empty}>Waiting for live updates</span>}
        {strip(0)}
        {!reducedMotion && strip(1)}
        {!reducedMotion && strip(2)}
      </div>
    </div>
  );
}

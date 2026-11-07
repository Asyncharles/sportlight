import type { FeedId, FeedState, HighlightConfig, IntensityReading, RunId } from '@sportlight/shared';

/**
 * Finds "moments" in a run's intensity stream.
 *
 * State machine per run:
 *   idle ──score ≥ enter──▶ active ──score < exit──▶ cooling ──(mergeGap s below exit)──▶ emit
 *                              ▲                         │
 *                              └──── score ≥ enter ──────┘   (close moments merge into one)
 *
 * Emission is deferred until `mergeGapSec` after the moment cools so its post-roll has actually been
 * broadcast and nearby peaks fold into a single clip. Very long sustained moments are split at
 * `2 × maxClipSec` so a highlight is produced while the action is still on.
 */

export interface Moment {
  feedId: FeedId;
  runId: RunId;
  /** Stream time when the score first reached the enter threshold. */
  start: number;
  /** Stream time when it fell below the exit threshold (or the run ended). */
  end: number;
  peak: { score: number; streamTime: number; at: string };
}

interface RunState {
  phase: 'idle' | 'active' | 'cooling';
  moment: Moment | null;
  coolingSince: number;
  lastStreamTime: number;
}

export class MomentDetector {
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly config: HighlightConfig) {}

  /** Feed one in-order reading; returns a completed moment when one is ready. */
  push(feed: Pick<FeedState, 'id' | 'runId'>, reading: IntensityReading): Moment | null {
    const key = `${feed.id}|${feed.runId}`;
    let st = this.runs.get(key);
    if (!st) {
      st = { phase: 'idle', moment: null, coolingSince: 0, lastStreamTime: -Infinity };
      this.runs.set(key, st);
    }
    if (reading.streamTime <= st.lastStreamTime) return null; // only in-order readings drive detection
    st.lastStreamTime = reading.streamTime;
    const { enterThreshold, exitThreshold, mergeGapSec, maxClipSec } = this.config;
    const t = reading.streamTime;

    switch (st.phase) {
      case 'idle':
        if (reading.score >= enterThreshold) {
          st.phase = 'active';
          st.moment = { feedId: feed.id, runId: feed.runId, start: t, end: t, peak: { ...reading } };
        }
        return null;

      case 'active': {
        const m = st.moment!;
        m.end = t;
        if (reading.score > m.peak.score) m.peak = { ...reading };
        if (reading.score < exitThreshold) {
          st.phase = 'cooling';
          st.coolingSince = t;
        } else if (t - m.start >= maxClipSec * 2) {
          // Sustained action: emit now, keep watching for the next peak.
          st.phase = reading.score >= enterThreshold ? 'active' : 'idle';
          st.moment =
            st.phase === 'active'
              ? { feedId: feed.id, runId: feed.runId, start: t, end: t, peak: { ...reading } }
              : null;
          return m;
        }
        return null;
      }

      case 'cooling': {
        const m = st.moment!;
        if (reading.score >= enterThreshold) {
          st.phase = 'active';
          m.end = t;
          if (reading.score > m.peak.score) m.peak = { ...reading };
          return null;
        }
        if (t - st.coolingSince >= mergeGapSec) {
          st.phase = 'idle';
          st.moment = null;
          return m;
        }
        return null;
      }
    }
  }

  /** The run ended or disappeared: flush any open moment. */
  flush(feedId: FeedId, runId: RunId): Moment | null {
    const key = `${feedId}|${runId}`;
    const st = this.runs.get(key);
    this.runs.delete(key);
    return st?.moment ?? null;
  }
}

/**
 * Choose the clip window (stream time) for a moment: pre-roll before it starts, post-roll after
 * it ends, bounded to [minClipSec, maxClipSec] and always containing the peak.
 */
export function clipWindow(moment: Moment, config: HighlightConfig): { start: number; end: number } {
  const { preRollSec, postRollSec, minClipSec, maxClipSec } = config;
  const p = moment.peak.streamTime;
  let start = moment.start - preRollSec;
  let end = moment.end + postRollSec;

  if (end - start > maxClipSec) {
    // Keep most of the window before the peak (the build-up), a little after it.
    const before = Math.min(p - start, maxClipSec * 0.7);
    start = p - before;
    end = Math.min(end, start + maxClipSec);
    start = Math.max(moment.start - preRollSec, end - maxClipSec);
  }
  if (end - start < minClipSec) {
    const pad = (minClipSec - (end - start)) / 2;
    start -= pad;
    end += pad;
  }
  if (start < 0) {
    end -= start;
    start = 0;
  }
  return { start: round(start), end: round(end) };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

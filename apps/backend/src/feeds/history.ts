import { appendFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dayKey, type FeedId, type IntensityReading, type RunId } from '@sportlight/shared';
import type { Logger } from '../logger.js';

export interface HistorySample {
  streamTime: number;
  score: number;
  at: string;
}

/**
 * Intensity history per feed run.
 *
 * Kept in memory (bounded, sorted by stream time — late readings are inserted in place) for
 * highlight curves and the admin view, and appended to daily NDJSON files under `DATA_DIR/history`
 * as the durable record. On GCP this maps naturally onto Cloud Storage or BigQuery.
 */
export class IntensityHistory {
  private readonly runs = new Map<
    string,
    { feedId: FeedId; runId: RunId; samples: HistorySample[]; touchedAt: number }
  >();

  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly limitPerRun: number,
    private readonly timezone: string,
    private readonly log: Logger,
    private readonly persist = true,
  ) {
    this.dir = join(dataDir, 'history');
  }

  async init() {
    if (this.persist) await mkdir(this.dir, { recursive: true });
  }

  /** Record a reading; returns false when it duplicates an existing sample. */
  add(feedId: FeedId, runId: RunId, reading: IntensityReading): boolean {
    const key = `${feedId}|${runId}`;
    let run = this.runs.get(key);
    if (!run) {
      run = { feedId, runId, samples: [], touchedAt: Date.now() };
      this.runs.set(key, run);
    }
    run.touchedAt = Date.now();
    const sample: HistorySample = { streamTime: reading.streamTime, score: reading.score, at: reading.at };
    const s = run.samples;
    // Fast path: in-order append.
    if (s.length === 0 || s[s.length - 1]!.streamTime < sample.streamTime) {
      s.push(sample);
    } else {
      const i = lowerBound(s, sample.streamTime);
      if (s[i]?.streamTime === sample.streamTime) return false;
      s.splice(i, 0, sample);
    }
    if (s.length > this.limitPerRun) s.splice(0, s.length - this.limitPerRun);
    this.append(feedId, runId, sample);
    return true;
  }

  /** Samples with stream time in [from, to]. */
  range(feedId: FeedId, runId: RunId, from: number, to: number): HistorySample[] {
    const s = this.runs.get(`${feedId}|${runId}`)?.samples ?? [];
    return s.slice(lowerBound(s, from), lowerBound(s, to + 1e-9));
  }

  /** The most recent `seconds` of samples. */
  recent(feedId: FeedId, runId: RunId, seconds: number): HistorySample[] {
    const s = this.runs.get(`${feedId}|${runId}`)?.samples ?? [];
    if (s.length === 0) return [];
    const last = s[s.length - 1]!.streamTime;
    return s.slice(lowerBound(s, last - seconds));
  }

  /** Forget runs that have not been touched for `maxIdleMs` (their durable copy stays on disk). */
  prune(maxIdleMs: number, now = Date.now()) {
    for (const [key, run] of this.runs) if (now - run.touchedAt > maxIdleMs) this.runs.delete(key);
  }

  async close() {}

  private append(feedId: FeedId, runId: RunId, sample: HistorySample) {
    if (!this.persist) return;
    const day = dayKey(Date.parse(sample.at), this.timezone);
    // Small PoC journal: complete the durable append before acknowledging the event.
    appendFileSync(join(this.dir, `${day}.ndjson`), JSON.stringify({ feedId, runId, ...sample }) + '\n', { flush: true });
  }

}

function lowerBound(s: HistorySample[], streamTime: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid]!.streamTime < streamTime) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

import { writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  dayKey,
  type HighlightCaption,
  fitClipToMedia,
  mediaTimeAt,
  thumbnailUrlAt,
  type FeedState,
  type Highlight,
  type HighlightConfig,
} from '@sportlight/shared';
import type { Logger } from '../logger.js';
import type { HistorySample } from '../feeds/history.js';
import { clipWindow, type Moment } from './detector.js';

export interface HighlightChanges {
  upserted: Highlight[];
  removed: string[];
}

const DAYS_IN_MEMORY = 7;
const CURVE_POINTS = 48;

/**
 * Retained highlights, by day.
 *
 * Avoids overlapping clips of the same moment two ways:
 *  - a moment overlapping (or within `mergeGapSec` of) an earlier highlight of the same run merges
 *    into it, keeping the higher peak;
 *  - with `dedupeByMedia`, clips covering ≥50% of the same media range (the demo media loops) keep
 *    only the higher-peaked one.
 * Persisted as one JSON document per day under `DATA_DIR/highlights`.
 */
export class HighlightStore {
  private readonly byDay = new Map<string, Map<string, Highlight>>();
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly config: HighlightConfig,
    private readonly log: Logger,
    private readonly persist = true,
    /** Names a new or changed highlight; receives the caption of the highlight it replaces. */
    private readonly nameHighlight: (h: Highlight, previous?: HighlightCaption) => HighlightCaption | undefined = () =>
      undefined,
  ) {
    this.dir = join(dataDir, 'highlights');
  }

  async init(now = Date.now()) {
    if (!this.persist) return;
    await mkdir(this.dir, { recursive: true });
    for (let i = 0; i < 2; i++) {
      const day = dayKey(now - i * 86_400_000, this.config.timezone);
      try {
        const list = JSON.parse(await readFile(join(this.dir, `${day}.json`), 'utf8')) as Highlight[];
        this.byDay.set(day, new Map(list.map((h) => [h.id, h])));
        this.log.info('loaded highlights', { day, count: list.length });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn('could not load highlights', { day, err });
      }
    }
  }

  /** Turn a completed moment into a highlight, applying merge and de-duplication rules. */
  addMoment(moment: Moment, feed: FeedState, samples: (from: number, to: number) => HistorySample[]): HighlightChanges {
    const changes: HighlightChanges = { upserted: [], removed: [] };
    const day = dayKey(Date.parse(moment.peak.at), this.config.timezone);
    const dayMap = this.dayMap(day);

    // 1. Earlier highlights of the same run that this moment touches fold into it.
    const mergeWith = [...dayMap.values()].filter((h) => {
      if (h.feedId !== moment.feedId || h.runId !== moment.runId) return false;
      const gap = Math.max(h.clip.streamStart - moment.end, moment.start - h.clip.streamEnd);
      return gap <= this.config.mergeGapSec;
    });
    const merged = mergeWith.reduce<Moment>(
      (acc, h) => ({
        ...acc,
        start: Math.min(acc.start, h.clip.streamStart + this.config.preRollSec),
        end: Math.max(acc.end, h.clip.streamEnd - this.config.postRollSec),
        peak: h.peak.score > acc.peak.score ? h.peak : acc.peak,
      }),
      moment,
    );
    const highlight = this.build(merged, feed, day, samples);
    const previous = mergeWith.find((h) => h.id === highlight.id) ?? mergeWith[0];
    const caption = this.nameHighlight(highlight, previous?.caption);
    if (caption) highlight.caption = caption;

    // 2. Same footage already covered by another clip? Keep whichever peaked higher.
    const conflicts = this.config.dedupeByMedia
      ? [...dayMap.values()].filter(
          (h) => !mergeWith.includes(h) && h.source.url === highlight.source.url && mediaOverlap(h, highlight) >= 0.5,
        )
      : [];
    if (conflicts.some((h) => h.peak.score >= highlight.peak.score)) return changes;

    // 3. Commit.
    for (const h of [...mergeWith, ...conflicts]) {
      dayMap.delete(h.id);
      changes.removed.push(h.id);
    }
    dayMap.set(highlight.id, highlight);
    changes.upserted.push(highlight);

    // 4. Enforce the per-day cap by dropping the least intense.
    if (dayMap.size > this.config.maxPerDay) {
      const weakest = [...dayMap.values()].sort((a, b) => a.peak.score - b.peak.score)[0]!;
      dayMap.delete(weakest.id);
      changes.removed.push(weakest.id);
      changes.upserted = changes.upserted.filter((h) => h.id !== weakest.id);
    }
    // An id that was merged away and re-created is an update, not a removal.
    changes.removed = changes.removed.filter((id) => !dayMap.has(id));
    this.markDirty(day);
    return changes;
  }

  /** Attach a (model-written) caption. Returns the updated highlight, if it still exists. */
  setCaption(id: string, caption: HighlightCaption): Highlight | undefined {
    for (const [day, m] of this.byDay) {
      const h = m.get(id);
      if (!h) continue;
      const next = { ...h, caption };
      m.set(id, next);
      this.markDirty(day);
      return next;
    }
    return undefined;
  }

  all(): Highlight[] {
    return [...this.byDay.values()].flatMap((m) => [...m.values()]);
  }

  list(day: string): Highlight[] {
    return [...(this.byDay.get(day)?.values() ?? [])].sort((a, b) => b.peak.score - a.peak.score);
  }

  get(id: string): Highlight | undefined {
    for (const m of this.byDay.values()) {
      const h = m.get(id);
      if (h) return h;
    }
    return undefined;
  }

  today(now = Date.now()): string {
    return dayKey(now, this.config.timezone);
  }

  /** Forget every highlight of every day, in memory and on disk. Returns the removed ids and the files freed. */
  async clear(): Promise<{ removed: string[]; files: number; bytes: number }> {
    const removed = this.all().map((h) => h.id);
    this.byDay.clear();
    this.dirty.clear();
    let files = 0;
    let bytes = 0;
    if (this.persist) {
      for (const name of await readdir(this.dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json(\.tmp)?$/.test(name)) continue;
        const file = join(this.dir, name);
        bytes += (await stat(file)).size;
        await unlink(file);
        files++;
      }
    }
    this.log.info('cleared highlights', { count: removed.length, files });
    return { removed, files, bytes };
  }

  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.persist) return;
    const days = [...this.dirty];
    this.dirty.clear();
    for (const day of days) {
      const file = join(this.dir, `${day}.json`);
      const tmp = `${file}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(this.list(day)));
        await rename(tmp, file);
      } catch (err) {
        this.log.error('could not persist highlights', { day, err });
        this.dirty.add(day);
      }
    }
  }

  private build(
    m: Moment,
    feed: FeedState,
    day: string,
    samples: (from: number, to: number) => HistorySample[],
  ): Highlight {
    const { start, end } = clipWindow(m, this.config);
    const source = feed.source;
    const peakMedia = mediaTimeAt(source, m.peak.streamTime);
    const { mediaStart, mediaEnd } = fitClipToMedia(
      peakMedia,
      m.peak.streamTime - start,
      end - m.peak.streamTime,
      source.durationSec,
    );
    const runStart = Date.parse(feed.startedAt);
    const id = createHash('sha1')
      .update(`${m.feedId}|${m.runId}|${Math.round(m.start)}`)
      .digest('hex')
      .slice(0, 12);

    return {
      id,
      day,
      feedId: m.feedId,
      runId: m.runId,
      sportId: feed.sportId,
      event: feed.event,
      source,
      clip: {
        streamStart: start,
        streamEnd: end,
        mediaStart,
        mediaEnd,
        durationSec: Math.round((mediaEnd - mediaStart) * 10) / 10,
      },
      peak: m.peak,
      startedAt: new Date(runStart + start * 1000).toISOString(),
      thumbnailUrl: thumbnailUrlAt(source, peakMedia),
      curve: downsample(samples(start, end), start, CURVE_POINTS),
    };
  }

  private dayMap(day: string) {
    let m = this.byDay.get(day);
    if (!m) {
      m = new Map();
      this.byDay.set(day, m);
      const days = [...this.byDay.keys()].sort();
      while (days.length > DAYS_IN_MEMORY) this.byDay.delete(days.shift()!);
    }
    return m;
  }

  private markDirty(day: string) {
    if (!this.persist) return;
    const file = join(this.dir, `${day}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(this.list(day)), { flush: true });
    renameSync(`${file}.tmp`, file);
  }
}

function mediaOverlap(a: Highlight, b: Highlight): number {
  const overlap = Math.min(a.clip.mediaEnd, b.clip.mediaEnd) - Math.max(a.clip.mediaStart, b.clip.mediaStart);
  const shorter = Math.min(a.clip.mediaEnd - a.clip.mediaStart, b.clip.mediaEnd - b.clip.mediaStart);
  return shorter > 0 ? Math.max(0, overlap) / shorter : 0;
}

function downsample(samples: HistorySample[], origin: number, max: number): Array<[number, number]> {
  if (samples.length <= max) return samples.map((s) => [round1(s.streamTime - origin), s.score]);
  const out: Array<[number, number]> = [];
  const step = samples.length / max;
  for (let i = 0; i < max; i++) {
    const bucket = samples.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    const top = bucket.reduce((a, b) => (b.score > a.score ? b : a));
    out.push([round1(top.streamTime - origin), top.score]);
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

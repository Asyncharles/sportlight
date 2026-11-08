import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Highlight } from '@sportlight/shared';
import { captionMediaUrl, type CaptionMediaOptions } from './caption-media.js';
import type { Logger } from '../logger.js';

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT = 3;
const WIDTH = 640;

/** Media second of a highlight's peak, within its replay range (same as the web's frame grab). */
export function peakMediaTime(h: Highlight): number {
  const t = h.clip.mediaStart + (h.peak.streamTime - h.clip.streamStart);
  return Math.min(h.clip.mediaEnd, Math.max(h.clip.mediaStart, t));
}

/**
 * JPEG stills for highlights whose source has no thumbnail strip (the engine's demo feeds). Without
 * these, every browser opened the multi-GB broadcast MP4 in a hidden <video> just to draw a tile.
 * ffmpeg seeks over HTTP, so a still costs the MP4 index plus one keyframe's bytes, once, on the
 * backend; the result is kept on disk and served with a long cache lifetime.
 */
export class HighlightStills {
  private readonly dir: string;
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(
    dataDir: string,
    private readonly opts: CaptionMediaOptions,
    private readonly log: Logger,
  ) {
    this.dir = join(dataDir, 'stills');
  }

  /** Path of the JPEG for this highlight's peak, rendering it if needed; null if it can't be made. */
  async file(h: Highlight): Promise<string | null> {
    const second = Math.round(peakMediaTime(h));
    const file = join(this.dir, `${h.id}-${second}.jpg`);
    if (await exists(file)) return file;
    let job = this.inflight.get(file);
    if (!job) {
      job = this.schedule(() => this.render(h, second, file)).finally(() => this.inflight.delete(file));
      this.inflight.set(file, job);
    }
    return job;
  }

  private schedule<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
          });
      };
      if (this.running < MAX_CONCURRENT) run();
      else this.queue.push(run);
    });
  }

  private async render(h: Highlight, second: number, file: string): Promise<string | null> {
    let url: string;
    try {
      url = captionMediaUrl(h.source.url, this.opts);
    } catch {
      return null;
    }
    await mkdir(this.dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp.jpg`;
    try {
      await execFileAsync(
        this.opts.ffmpegPath ?? 'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-protocol_whitelist',
          'http,https,tcp,tls,crypto',
          '-rw_timeout',
          '15000000',
          '-ss',
          String(second),
          '-i',
          url,
          '-frames:v',
          '1',
          '-vf',
          `scale=${WIDTH}:-2`,
          '-q:v',
          '4',
          temporary,
        ],
        { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 256_000 },
      );
      if ((await stat(temporary)).size < 100) throw new Error('empty still');
      await rename(temporary, file);
      return file;
    } catch {
      // Don't log ffmpeg stderr: it can include signed source URLs.
      this.log.warn('could not render highlight still', { id: h.id });
      await rm(temporary, { force: true });
      return null;
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Highlight } from '@sportlight/shared';
import { HighlightStills, peakMediaTime } from './stills.js';
import { createLogger } from '../logger.js';

const h = {
  id: 'abc123def456',
  source: { url: '/media/local/videos/game.mp4' },
  clip: { streamStart: 100, mediaStart: 40, mediaEnd: 60 },
  peak: { streamTime: 112 },
} as unknown as Highlight;

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('highlight stills', () => {
  it('picks the peak inside the replay window', () => {
    expect(peakMediaTime(h)).toBe(52);
    expect(peakMediaTime({ ...h, peak: { streamTime: 500 } } as unknown as Highlight)).toBe(60);
  });

  it('serves a cached still without running ffmpeg', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stills-'));
    const stills = new HighlightStills(
      dir,
      { mediaFetchBase: 'http://media:8080', mediaPublicPrefix: '/media', ffmpegPath: '/nonexistent/ffmpeg' },
      createLogger('test'),
    );
    await mkdir(join(dir, 'stills'));
    await writeFile(join(dir, 'stills', 'abc123def456-52.jpg'), 'jpeg');
    const file = await stills.file(h);
    expect(file && (await readFile(file, 'utf8'))).toBe('jpeg');
  });

  it('returns null when ffmpeg fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stills-'));
    const stills = new HighlightStills(
      dir,
      { mediaFetchBase: 'http://127.0.0.1:9', mediaPublicPrefix: '/media', ffmpegPath: '/nonexistent/ffmpeg' },
      createLogger('test'),
    );
    expect(await stills.file(h)).toBeNull();
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Highlight } from '@sportlight/shared';

const execFileAsync = promisify(execFile);
export interface CaptionMedia {
  mimeType: 'video/mp4';
  base64: string;
}
export interface CaptionMediaOptions {
  mediaFetchBase: string | null;
  mediaPublicPrefix: string;
  ffmpegPath?: string;
}

export function captionMediaUrl(url: string, opts: CaptionMediaOptions): string {
  let absolute = url;
  if (url.startsWith('/') && !url.startsWith('//')) {
    if (!opts.mediaFetchBase) throw new Error('MEDIA_FETCH_BASE is required for highlight video captions');
    const prefix = opts.mediaPublicPrefix.replace(/\/$/, '');
    const path = prefix && url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : url;
    absolute = `${opts.mediaFetchBase.replace(/\/$/, '')}${path}`;
  }
  const parsed = new URL(absolute);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Highlight video must use an HTTP(S) media URL without credentials');
  }
  return parsed.href;
}

/** Cut the exact replay window, preserving audio. Bound duration, time and upload size. */
export async function extractCaptionVideo(
  h: Highlight,
  opts: CaptionMediaOptions,
  signal: AbortSignal,
): Promise<CaptionMedia> {
  const start = h.clip.mediaStart;
  const duration = h.clip.mediaEnd - start;
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 120) {
    throw new Error('Caption video window must be between 0 and 120 seconds');
  }
  const url = captionMediaUrl(h.source.url, opts);
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), 'sportlight-caption-'));
  const output = join(dir, 'clip.mp4');
  try {
    await execFileAsync(
      opts.ffmpegPath ?? 'ffmpeg',
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
        String(start),
        '-i',
        url,
        '-t',
        String(duration),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=8',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '25',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ac',
        '1',
        '-b:a',
        '64k',
        '-movflags',
        '+faststart',
        '-fs',
        '14000000',
        output,
      ],
      { signal, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 256_000 },
    ).catch(() => {
      // Do not leak signed source URLs from ffmpeg stderr into logs.
      throw new Error('Could not extract highlight video (check media access, ffmpeg and timeout)');
    });
    const size = (await stat(output)).size;
    if (size < 100 || size >= 14_000_000) throw new Error('Caption video is empty or exceeds the upload limit');
    return { mimeType: 'video/mp4', base64: (await readFile(output)).toString('base64') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

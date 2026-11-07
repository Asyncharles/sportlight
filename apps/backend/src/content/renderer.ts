import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Highlight } from '@sportlight/shared';

export function sourceUrl(highlight: Highlight, base: string, prefix: string): string {
  const origin = new URL(base);
  const source = highlight.source.url;
  // Only the configured media origin can be fetched by the renderer.
  const url = source.startsWith(`${prefix}/`)
    ? new URL(source.slice(prefix.length + 1), `${base.replace(/\/$/, '')}/`)
    : new URL(source, origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.origin || url.username || url.password) {
    throw new Error('Source is outside the configured media origin');
  }
  if (!url.pathname.endsWith('.mp4')) throw new Error('Only retained MP4 sources are supported');
  return url.href;
}
export async function renderClip(highlight: Highlight, dir: string, base: string, prefix: string, ffmpeg: string) {
  const duration = highlight.clip.mediaEnd - highlight.clip.mediaStart;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 180 ||
    !Number.isFinite(highlight.clip.mediaStart) ||
    highlight.clip.mediaStart < 0
  ) {
    throw new Error('Clip must be between 0 and 180 seconds');
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, 'render.tmp.mp4');
  const file = join(dir, 'short.mp4');
  // Preserve the complete sports frame, centered in a portrait composition. No shell interpolation.
  const filter =
    'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x171917,setsar=1';
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-protocol_whitelist',
          'http,https,tcp,tls,crypto',
          '-rw_timeout',
          '30000000',
          '-ss',
          String(highlight.clip.mediaStart),
          '-i',
          sourceUrl(highlight, base, prefix),
          '-t',
          String(duration),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-vf',
          filter,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          temporary,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      // Do not expose FFmpeg's source URLs or origin responses in logs/UI.
      child.stderr.resume();
      const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not start FFmpeg. Check FFMPEG_PATH.'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error('Clip render failed. Check source availability and FFmpeg installation.'));
      });
    });
    if ((await stat(temporary)).size === 0) throw new Error('Rendered clip is empty');
    await rename(temporary, file);
    return file;
  } finally {
    await rm(temporary, { force: true });
  }
}

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptionCue, Highlight } from '@sportlight/shared';
import { CUES, FRAME, renderOverlays, VIDEO } from './overlays.js';
import { alignCues, decodeAudio } from './speech.js';
import { namePrompt, transcribe, type WhisperOptions } from './transcribe.js';

export type CaptionSource = 'whisper' | 'model' | 'description' | 'none';

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
/**
 * FFmpeg filter graph for a branded vertical Short:
 * blurred full-bleed backdrop → scrims and shadow → rounded, sharpened 16:9 video → logo/title
 * chrome → timed commentary cards that fade in and out → whole-video fade in/out.
 * Inputs: 0 source, 1 under, 2 mask, 3 chrome, 4… cue cards.
 */
export function shortFilter(duration: number, cues: ReadonlyArray<{ start: number; end: number }>): string {
  const t = (n: number) => n.toFixed(3);
  const graph = [
    `[0:v]setsar=1,split=2[src_bg][src_fg]`,
    // Blur at quarter resolution: smooth and cheap at 1080x1920.
    `[src_bg]scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=increase,crop=${FRAME.width}:${FRAME.height},` +
      `scale=270:480,boxblur=18:3,scale=${FRAME.width}:${FRAME.height}:flags=bicubic,eq=brightness=-0.08:saturation=1.2[bg]`,
    `[src_fg]scale=${VIDEO.width}:${VIDEO.height}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${VIDEO.width}:${VIDEO.height},unsharp=5:5:0.55:5:5:0,format=yuva420p[fg_raw]`,
    `[2:v]format=gray[mask]`,
    `[fg_raw][mask]alphamerge[fg]`,
    `[bg][1:v]overlay=0:0:format=auto[l_under]`,
    `[l_under][fg]overlay=${VIDEO.x}:${VIDEO.y}:format=auto[l_video]`,
    `[l_video][3:v]overlay=0:0:format=auto[l0]`,
  ];
  cues.forEach((cue, i) => {
    const fade = Math.min(0.18, (cue.end - cue.start) / 4);
    graph.push(
      `[${4 + i}:v]format=rgba,fade=t=in:st=${t(cue.start)}:d=${t(fade)}:alpha=1,` +
        `fade=t=out:st=${t(cue.end - fade)}:d=${t(fade)}:alpha=1[cue${i}]`,
      `[l${i}][cue${i}]overlay=0:${CUES.y}:format=auto:enable='between(t,${t(cue.start)},${t(cue.end)})'[l${i + 1}]`,
    );
  });
  const out = Math.max(0, duration - 0.4);
  graph.push(`[l${cues.length}]fade=t=in:st=0:d=0.35,fade=t=out:st=${t(out)}:d=0.4,format=yuv420p[out]`);
  return graph.join(';');
}

export async function renderClip(
  highlight: Highlight,
  dir: string,
  base: string,
  prefix: string,
  ffmpeg: string,
  whisper?: WhisperOptions,
): Promise<{ file: string; captions: CaptionSource; warning?: string }> {
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
  const graphics = await mkdtemp(join(dir, 'overlays-'));
  try {
    const source = sourceUrl(highlight, base, prefix);
    // Commentary captions: Whisper's word-timed transcript first; otherwise the caption model's
    // cues, snapped to where speech is actually heard.
    const audio = await decodeAudio(ffmpeg, source, highlight.clip.mediaStart, duration, graphics);
    let cues = [] as CaptionCue[];
    let captions: CaptionSource = 'none';
    let warning: string | undefined;
    if (whisper && audio.wav && audio.speech.length) {
      const result = await transcribe(whisper, audio.wav, namePrompt(highlight), audio.speech, duration);
      cues = result.cues;
      warning = result.error;
      if (cues.length) captions = 'whisper';
    }
    if (!cues.length && highlight.caption?.commentary?.length) {
      cues = alignCues(highlight.caption.commentary, audio.speech, duration);
      captions = 'model';
    }
    const baseCaption = highlight.caption ?? { title: highlight.event.title, description: '', tags: [], model: 'template', generatedAt: '' };
    const timed: Highlight = { ...highlight, caption: { ...baseCaption, commentary: cues } };
    const overlays = await renderOverlays(timed, graphics, duration);
    if (captions === 'none' && overlays.cues.length) captions = 'description';
    const still = (path: string) => ['-loop', '1', '-framerate', '30', '-t', String(duration), '-i', path];
    const args = [
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
      '-t',
      String(duration),
      '-i',
      source,
      ...still(overlays.under),
      ...still(overlays.mask),
      ...still(overlays.chrome),
      ...overlays.cues.flatMap((c) => still(c.file)),
      '-filter_complex',
      shortFilter(duration, overlays.cues),
      '-map',
      '[out]',
      '-map',
      '0:a:0?',
      // YouTube's loudness target, with gentle fades so the cut never clicks.
      '-af',
      `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,afade=t=in:d=0.25,afade=t=out:st=${Math.max(0, duration - 0.4).toFixed(3)}:d=0.4`,
      '-t',
      String(duration),
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '17',
      '-profile:v',
      'high',
      '-level:v',
      '4.2',
      '-maxrate',
      '20M',
      '-bufsize',
      '40M',
      '-g',
      '60',
      '-bf',
      '2',
      '-pix_fmt',
      'yuv420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-color_range',
      'tv',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      temporary,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
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
    return { file, captions, warning };
  } finally {
    await rm(temporary, { force: true });
    await rm(graphics, { recursive: true, force: true });
  }
}

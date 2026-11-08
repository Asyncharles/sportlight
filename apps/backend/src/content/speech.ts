import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptionCue } from '@sportlight/shared';

/**
 * Caption timing. The model's cue timestamps are approximate (often ±1 s), so before burning them
 * in we find where speech actually starts and stops in the clip's audio and snap each cue to it.
 * Commentary sits well above crowd noise in the speech band, so a simple energy detector suffices.
 */

export interface Segment {
  start: number;
  end: number;
}
const RATE = 16_000;
const FRAME_SEC = 0.05;

/** Speech-band (250–3400 Hz) loudness per 50 ms frame, in dB. */
export function frameLevels(samples: Int16Array): number[] {
  const size = Math.round(RATE * FRAME_SEC);
  const levels: number[] = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += samples[j]! * samples[j]!;
    levels.push(20 * Math.log10(Math.sqrt(sum / size) + 1));
  }
  return levels;
}

/** Voiced segments from frame levels, with an adaptive threshold between the noise floor and peaks. */
export function speechSegments(levels: number[]): Segment[] {
  if (levels.length < 10) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const floor = pct(0.1);
  const peak = pct(0.9);
  if (peak - floor < 6) return []; // No contrast: no clear speech to align to.
  const threshold = floor + 0.4 * (peak - floor);
  // Smooth over 150 ms so syllable gaps do not split words.
  const voiced = levels.map((_, i) => {
    const window = levels.slice(Math.max(0, i - 1), i + 2);
    return window.reduce((a, b) => a + b, 0) / window.length > threshold;
  });
  const raw: Segment[] = [];
  voiced.forEach((v, i) => {
    const t = i * FRAME_SEC;
    const last = raw.at(-1);
    if (!v) return;
    if (last && t - last.end <= 0.35) last.end = t + FRAME_SEC;
    else raw.push({ start: t, end: t + FRAME_SEC });
  });
  return raw.filter((s) => s.end - s.start >= 0.3).map((s) => ({ start: round(s.start), end: round(s.end) }));
}

/**
 * Snap cue edges to the nearest speech onset/offset within `reach` seconds, keep order, avoid
 * overlaps, and hold each cue briefly after speech stops so it can be read.
 */
export function alignCues(cues: CaptionCue[], segments: Segment[], durationSec: number, reach = 1.2): CaptionCue[] {
  if (!segments.length) return cues;
  const onsets = segments.map((s) => s.start);
  const offsets = segments.map((s) => s.end);
  const nearest = (points: number[], t: number) => {
    let best: number | undefined;
    for (const p of points) if (Math.abs(p - t) <= reach && (best === undefined || Math.abs(p - t) < Math.abs(best - t))) best = p;
    return best;
  };
  const inSpeech = (t: number) => segments.some((s) => t >= s.start && t < s.end);
  const out: CaptionCue[] = [];
  for (const cue of cues) {
    // A start already inside speech (mid-sentence split) stays put unless an onset is close by.
    let start = nearest(onsets, cue.start) ?? cue.start;
    if (inSpeech(cue.start) && Math.abs(start - cue.start) > 0.9) start = cue.start;
    let end = nearest(offsets, cue.end) ?? cue.end;
    if (inSpeech(cue.end) && Math.abs(end - cue.end) > 0.9) end = cue.end;
    if (end - start < 0.6) end = start + Math.max(0.6, cue.end - cue.start);
    start = Math.max(start, out.at(-1)?.end ?? 0);
    if (end - start < 0.4) continue;
    out.push({ start: round(start), end: round(end), text: cue.text });
  }
  // Reading hold: linger up to 0.4 s after speech, never into the next cue or past the clip.
  return out.map((c, i) => ({
    ...c,
    end: round(Math.min(c.end + 0.4, out[i + 1]?.start ?? durationSec, durationSec)),
  }));
}

/**
 * Decode the clip's audio once: a 16 kHz mono WAV for transcription, plus speech-band samples
 * for voice detection. Resolves with no WAV when the clip has no audio or decoding fails.
 */
export async function decodeAudio(
  ffmpeg: string,
  url: string,
  start: number,
  duration: number,
  dir: string,
): Promise<{ wav?: string; speech: Segment[] }> {
  const wav = join(dir, 'audio.wav');
  const raw = join(dir, 'speech.raw');
  const ok = await new Promise<boolean>((resolve) => {
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
        String(start),
        '-t',
        String(duration),
        '-i',
        url,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        String(RATE),
        '-c:a',
        'pcm_s16le',
        wav,
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        String(RATE),
        '-af',
        'highpass=f=250,lowpass=f=3400',
        '-f',
        's16le',
        raw,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  if (!ok) return { speech: [] };
  const buffer = await readFile(raw);
  const samples = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
  return { wav, speech: speechSegments(frameLevels(samples)) };
}

const round = (n: number) => Math.round(n * 100) / 100;

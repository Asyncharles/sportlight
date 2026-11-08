import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { cpus } from 'node:os';
import { getCompetition, type CaptionCue, type Highlight } from '@sportlight/shared';
import type { Segment } from './speech.js';

/**
 * Commentary transcription with whisper.cpp. Word timings come from its DTW alignment
 * (`--dtw`, which requires flash attention off), which tracks the audio far more closely
 * than a multimodal model's timestamps. A prompt built from the fixture and any model
 * caption steers the spelling of player and team names.
 */

export interface WhisperOptions {
  /** whisper.cpp CLI binary (`whisper-cli`). */
  path: string;
  /** ggml model file, e.g. ggml-small.bin. */
  model: string;
  /** DTW alignment preset; derived from the model file name when omitted. */
  dtw?: string;
}
export interface Word {
  start: number;
  end: number;
  text: string;
}
interface Token {
  text: string;
  p?: number;
  t_dtw?: number;
}

/** `ggml-small.bin` → `small`, `ggml-large-v3-turbo.bin` → `large.v3.turbo`, `ggml-base.en.bin` → `base.en`. */
export function dtwPreset(model: string): string {
  return basename(model)
    .replace(/^ggml-/, '')
    .replace(/(-q\d.*)?\.bin$/, '')
    .replace(/-/g, '.');
}

/** Vocabulary hint: fixture, competition and any caption text, which carry the names spoken. */
export function namePrompt(h: Highlight): string {
  const c = h.caption?.model !== 'template' ? h.caption : undefined;
  return [
    h.event.title,
    h.event.subtitle,
    getCompetition(h.event.competitionId)?.name,
    c?.title,
    c?.description,
    c?.commentary?.map((cue) => cue.text).join(' '),
  ]
    .filter(Boolean)
    .join('. ')
    .replace(/\s+/g, ' ')
    .slice(0, 600);
}

/** Group whisper tokens into words: a leading space starts a word; punctuation joins the previous one. */
export function tokensToWords(tokens: Token[], speech: Segment[], durationSec: number): Word[] {
  const words: Array<{ start: number; last: number; text: string; p: number[] }> = [];
  for (const t of tokens) {
    if (/^\s*\[_?[A-Z_0-9]+_?\]\s*$/.test(t.text) || /^\[_/.test(t.text) || t.t_dtw === undefined || t.t_dtw < 0) continue;
    const at = t.t_dtw / 100;
    const last = words.at(-1);
    if (last && !/^\s/.test(t.text)) {
      last.text += t.text;
      // Punctuation tokens are timed late; only spoken pieces move the word's end.
      if (/[\p{L}\p{N}]/u.test(t.text)) last.last = at;
      if (t.p !== undefined) last.p.push(t.p);
    } else if (t.text.trim()) {
      words.push({ start: at, last: at, text: t.text.trim(), p: t.p === undefined ? [] : [t.p] });
    }
  }
  const voiced = (t: number) => !speech.length || speech.some((s) => t >= s.start - 0.3 && t <= s.end + 0.3);
  const segmentEnd = (t: number) => speech.find((s) => t >= s.start - 0.3 && t <= s.end + 0.3)?.end ?? Infinity;
  // Whisper can echo its prompt as a burst of words stamped at one instant; real speech is spread out.
  const burst = (i: number) => {
    const near = words.filter((w) => Math.abs(w.start - words[i]!.start) < 0.05);
    return near.length >= 3;
  };
  const kept = words.filter((w, i) => {
    const confidence = w.p.length ? w.p.reduce((a, b) => a + b, 0) / w.p.length : 1;
    // Whisper invents phrases over crowd noise; keep only words heard during detected speech.
    return confidence >= 0.2 && voiced(w.start) && w.start < durationSec && !burst(i);
  });
  return kept.map((w, i) => {
    const next = kept[i + 1]?.start ?? durationSec;
    // End shortly after the word's last spoken token, but not long after the speech itself stops.
    const end = Math.min(next, w.last + 0.35, segmentEnd(w.start) + 0.15, durationSec);
    return { start: round(w.start), end: round(Math.max(end, w.start + 0.15)), text: w.text };
  });
}

/**
 * Readable cues from words: break at pauses, at about 50 characters or 3.5 seconds, and
 * preferably at sentence or clause ends. Each cue lingers briefly for reading.
 */
export function wordsToCues(words: Word[], durationSec: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cur: CaptionCue | undefined;
  for (const w of words) {
    if (cur) {
      const gap = w.start - cur.end;
      const long = cur.text.length + w.text.length + 1 > 50 || w.end - cur.start > 3.5;
      const clause = /[.!?,;:]$/.test(cur.text) && cur.text.length >= 18;
      if (gap > 0.6 || long || clause) {
        cues.push(cur);
        cur = undefined;
      }
    }
    if (!cur) cur = { start: w.start, end: w.end, text: w.text };
    else {
      cur.end = w.end;
      cur.text += ` ${w.text}`;
    }
  }
  if (cur) cues.push(cur);
  return cues.filter((c) => c.end - c.start >= 0.3).map((c, i) => ({
    start: c.start,
    end: round(Math.min(c.end + 0.4, cues[i + 1]?.start ?? durationSec, durationSec)),
    text: c.text,
  }));
}

/** Transcribe a 16 kHz mono WAV. Resolves to [] when whisper is unavailable or fails. */
export async function transcribe(
  options: WhisperOptions,
  wav: string,
  prompt: string,
  speech: Segment[],
  durationSec: number,
): Promise<{ cues: CaptionCue[]; error?: string }> {
  try {
    await access(options.model);
  } catch {
    return { cues: [], error: 'Whisper model not found; set WHISPER_MODEL.' };
  }
  const out = wav.replace(/\.wav$/, '');
  const args = [
    '-m',
    options.model,
    '-f',
    wav,
    '-l',
    'auto',
    '-nfa',
    '-dtw',
    options.dtw || dtwPreset(options.model),
    '-t',
    String(Math.max(1, Math.min(8, cpus().length))),
    '-ojf',
    '-of',
    out,
    '-np',
    ...(prompt ? ['--prompt', prompt] : []),
  ];
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn(options.path, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  if (!ok) return { cues: [], error: 'Whisper transcription failed; check WHISPER_PATH and WHISPER_MODEL.' };
  const json = JSON.parse(await readFile(`${out}.json`, 'utf8')) as { transcription?: { tokens?: Token[] }[] };
  const tokens = (json.transcription ?? []).flatMap((s) => s.tokens ?? []);
  return { cues: wordsToCues(tokensToWords(tokens, speech, durationSec), durationSec) };
}

const round = (n: number) => Math.round(n * 100) / 100;

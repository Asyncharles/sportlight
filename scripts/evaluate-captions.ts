/** Run with: npx tsx scripts/evaluate-captions.ts [--live]
 * --live sends three actual highlight clips to Gemini using GEMINI_API_KEY.
 * Without it, validates extraction locally. Never modifies the saved highlights.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Highlight } from '@sportlight/shared';
import { extractCaptionVideo } from '../apps/backend/src/highlights/caption-media.js';
import { GeminiCaptioner, TemplateCaptioner, CAPTION_VERSION } from '../apps/backend/src/highlights/captioner.js';

const live = process.argv.includes('--live');
const apiKey = process.env.GEMINI_API_KEY;
if (live && !apiKey) throw new Error('Set GEMINI_API_KEY in the environment before using --live');
const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const model = live ? new GeminiCaptioner(apiKey!, modelName) : null;
const response = await fetch(`${process.env.BACKEND_URL || 'http://localhost:4000'}/api/highlights`);
if (!response.ok) throw new Error(`Cannot read highlights: HTTP ${response.status}`);
const { highlights } = (await response.json()) as { highlights: Highlight[] };
const selected: Highlight[] = [];
for (const h of highlights) {
  if (!selected.some((s) => s.sportId === h.sportId)) selected.push(h);
  if (selected.length === 3) break;
}
if (!selected.length) throw new Error('No highlights available to evaluate');
const output = resolve(process.env.CAPTION_EVAL_DIR || 'apps/backend/data/caption-evaluation');
await mkdir(output, { recursive: true });
const results = [];
for (const h of selected) {
  const started = Date.now();
  console.log(`Checking ${h.sportId}: ${h.event.title} (${h.id})`);
  const media = await extractCaptionVideo(
    h,
    {
      mediaFetchBase: process.env.MEDIA_FETCH_BASE || 'http://localhost:5173/media',
      mediaPublicPrefix: process.env.MEDIA_PUBLIC_PREFIX || '/media',
      ffmpegPath: process.env.FFMPEG_PATH,
    },
    AbortSignal.timeout(90_000),
  );
  const clipPath = join(output, `${h.id}.mp4`);
  const bytes = Buffer.from(media.base64, 'base64');
  await writeFile(clipPath, bytes);
  const { stdout } = await promisify(execFile)(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,avg_frame_rate',
    '-of',
    'json',
    clipPath,
  ]);
  const probe = JSON.parse(stdout);
  const expectedDuration = h.clip.mediaEnd - h.clip.mediaStart;
  const actualDuration = Number(probe.format.duration);
  if (Math.abs(expectedDuration - actualDuration) > 0.5) throw new Error(`Extracted duration mismatch for ${h.id}`);
  const hasVideo = probe.streams.some((s: { codec_type: string }) => s.codec_type === 'video');
  const hasAudio = probe.streams.some((s: { codec_type: string }) => s.codec_type === 'audio');
  if (!hasVideo || (h.source.hasAudio && !hasAudio)) throw new Error(`Missing expected media tracks for ${h.id}`);
  const after = model ? await model.caption(h, media, AbortSignal.timeout(120_000)) : null;
  results.push({
    id: h.id,
    sport: h.sportId,
    event: h.event.title,
    source: h.source.url,
    window: [h.clip.mediaStart, h.clip.mediaEnd],
    expectedDuration,
    actualDuration,
    hasAudio,
    bytes: bytes.length,
    elapsedMs: Date.now() - started,
    clipPath,
    before: h.caption,
    fallback: new TemplateCaptioner().draft(h),
    after,
    probe,
  });
  console.log(JSON.stringify(results.at(-1), null, 2));
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify(
      {
        mode: live ? 'live-model' : 'local-extraction-only',
        version: CAPTION_VERSION,
        model: model?.name ?? null,
        generatedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
  );
}
console.log(`Report: ${join(output, 'results.json')}`);
if (!live) console.log('No model was called. Run again with --live and GEMINI_API_KEY to compare generated captions.');

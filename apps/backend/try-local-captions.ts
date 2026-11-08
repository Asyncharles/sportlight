// Temporary: caption a few real highlights with the local model.
import { readFileSync } from 'node:fs';
import { extractCaptionVideo } from './src/highlights/caption-media.js';
import { LocalCaptioner } from './src/highlights/local-captioner.js';

const data = JSON.parse(readFileSync('data/highlights/2026-11-08.json', 'utf8'));
const all = (Array.isArray(data) ? data : data.highlights) as any[];
const seen = new Set<string>();
const picks = all.filter((h) => !seen.has(h.sportId) && seen.add(h.sportId)).slice(0, Number(process.argv[2] ?? 4));
const c = new LocalCaptioner({
  endpoint: 'http://127.0.0.1:8081', model: 'qwen2.5-vl-7b', ffmpegPath: 'ffmpeg',
  whisper: { path: 'whisper-cli', model: 'data/models/ggml-small.bin' },
});
for (const h of picks) {
  const t = Date.now();
  try {
    const media = await extractCaptionVideo(h, { mediaFetchBase: 'http://localhost:5173/media', mediaPublicPrefix: '/media', ffmpegPath: 'ffmpeg' }, AbortSignal.timeout(120_000));
    const d = await c.caption(h, media, AbortSignal.timeout(120_000));
    console.log(JSON.stringify({ sport: h.sportId, event: h.event.title, sec: (Date.now() - t) / 1000, ...d, commentary: d.commentary?.length ?? 0 }, null, 1));
  } catch (e) {
    console.log(h.sportId, 'ERROR', (e as Error).message);
  }
}

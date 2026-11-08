#!/usr/bin/env node
// Engine footage on local disk → media/dist/local (catalog, posters, thumbnails): the demo clips, and
// the tuning clips as "extra" feeds that viewers can turn on in Settings.
// The MP4s are not copied or re-encoded: the media server serves them straight from the footage
// folder, so the browser plays the exact bytes the engine's pushers loop and t_video lines up.
// Usage: npm run media:local -- --from=<samples dir> [--only=feed-id] [--force]
//        <samples dir> mirrors the bucket's samples/: demo clips at the top, tuning clips in tuning/<sport>/.
//        (or set LOCAL_FOOTAGE_DIR instead of --from)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'dist', 'local');
const args = process.argv.slice(2);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const from = arg('from') ?? process.env.LOCAL_FOOTAGE_DIR;
const only = arg('only');
const force = args.includes('--force');
const log = (...a) => console.log('[local]', ...a);

function run(cmd, cmdArgs) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-8000)));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}
const ffmpeg = (a) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);

/** True when the moov box comes before mdat, so browsers can start playing and seek straight away. */
export async function isFastStart(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(16);
    for (let pos = 0; pos + 8 <= size; ) {
      await fh.read(head, 0, 16, pos);
      const type = head.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      let box = head.readUInt32BE(0);
      if (box === 1) box = Number(head.readBigUInt64BE(8));
      if (box < 8) return false; // size 0 (to end of file) or corrupt
      pos += box;
    }
    return false;
  } finally {
    await fh.close();
  }
}

async function probe(file) {
  const p = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
  return {
    duration: Number(p.format.duration),
    video: p.streams.find((s) => s.codec_type === 'video'),
    audio: p.streams.find((s) => s.codec_type === 'audio'),
  };
}

export const DATASETS = { demo: 'local-engine-v1', extra: 'local-extra-v1' };

async function build(clip, footageDir, intervalSec, previous) {
  const file = join(footageDir, ...clip.file.split('/'));
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const { size, mtimeMs } = await stat(file);
  const key = JSON.stringify({ clip, size, mtimeMs: Math.round(mtimeMs), intervalSec, version: 1 });
  const poster = `local/posters/${clip.id}.jpg`;
  if (!force && previous?.importKey === key && existsSync(join(ROOT, 'dist', poster))) {
    log(`${clip.id}: up to date`);
    return previous;
  }
  const info = await probe(file);
  if (info.video?.codec_name !== 'h264') throw new Error(`${clip.file}: video must be H.264 for browsers`);
  if (info.audio && info.audio.codec_name !== 'aac') throw new Error(`${clip.file}: audio must be AAC for browsers`);
  if (!(await isFastStart(file)))
    throw new Error(
      `${clip.file}: not fast-start, so browsers cannot stream it. Fix the source once with ` +
        `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4 (no re-encode, timeline unchanged)`,
    );
  log(`${clip.id}: ${Math.round(info.duration / 60)} min, ${info.video.height}p; making poster and thumbnails`);
  await mkdir(join(OUT, 'posters'), { recursive: true });
  await ffmpeg(['-ss', String(Math.min(60, info.duration / 4)), '-i', file, '-frames:v', '1', '-vf', 'scale=960:-2',
    '-q:v', '4', join(ROOT, 'dist', poster)]);
  const thumbDir = join(OUT, 'thumbs', clip.id);
  await rm(thumbDir, { recursive: true, force: true });
  await mkdir(thumbDir, { recursive: true });
  await ffmpeg(['-skip_frame', 'nokey', '-i', file, '-vf', `fps=1/${intervalSec}:round=down,scale=480:-2`,
    '-q:v', '5', '-start_number', '0', join(thumbDir, '%d.jpg')]);
  return {
    id: clip.id,
    sportId: clip.sportId,
    competitionId: clip.competitionId,
    dataset: DATASETS[clip.role ?? 'demo'],
    private: true,
    video: `local/videos/${clip.file}`,
    poster,
    durationSec: info.duration,
    width: info.video.width,
    height: info.video.height,
    fps: info.video.avg_frame_rate,
    hasAudio: Boolean(info.audio),
    synthetic: false,
    startOffsetSec: 0, // t_video 0 is the start of the file, as for the engine
    event: clip.event,
    thumbnails: {
      template: `local/thumbs/${clip.id}/{index}.jpg`,
      intervalSec,
      count: (await readdir(thumbDir)).filter((n) => n.endsWith('.jpg')).length,
    },
    credits: [
      {
        title: clip.event.title,
        author: clip.event.broadcaster.name,
        license: 'Private demo footage, not licensed for redistribution',
        licenseUrl: null,
        sourceUrl: clip.sourceUrl,
      },
    ],
    attributionNotice: 'Private hackathon demo footage. Do not publish or export.',
    importKey: key,
  };
}

async function main() {
  if (!from) throw new Error('Pass --from=<folder with the demo MP4s> or set LOCAL_FOOTAGE_DIR');
  const footageDir = resolve(from);
  const sources = JSON.parse(await readFile(join(ROOT, 'local-sources.json'), 'utf8'));
  if (only && !sources.clips.some((c) => c.id === only)) throw new Error(`Unknown feed id: ${only}`);
  await mkdir(OUT, { recursive: true });
  const catalogPath = join(OUT, 'catalog.json');
  const previous = existsSync(catalogPath) ? JSON.parse(await readFile(catalogPath, 'utf8')).clips : [];
  const byId = new Map(previous.map((c) => [c.id, c]));
  const failures = [];
  for (const clip of sources.clips) {
    if (only && clip.id !== only) continue;
    try {
      byId.set(clip.id, await build(clip, footageDir, sources.thumbnailIntervalSec, byId.get(clip.id)));
    } catch (e) {
      failures.push(clip.id);
      console.error(`[local] ${clip.id}: ${e.message}`);
    }
  }
  const wanted = new Set(sources.clips.map((c) => c.id));
  const clips = [...byId.values()].filter((c) => wanted.has(c.id));
  const temp = `${catalogPath}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), clips }, null, 2));
  await rename(temp, catalogPath);
  log(`${clips.length} local feeds in ${catalogPath}; ${failures.length} failures`);
  log(`serve ${footageDir} at /media/local/videos (LOCAL_FOOTAGE_DIR) so browsers can play them`);
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[local]', e.message);
    process.exitCode = 1;
  });
}

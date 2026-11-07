#!/usr/bin/env node
// Full broadcast replays → local, browser-compatible MP4s. No trimming or speed changes.
// Usage: npm run media -- [--only=clip-id] [--force]
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, statfs, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const CACHE = join(ROOT, '.cache', 'youtube');
const YTDLP =
  process.env.YT_DLP ?? (existsSync(join(ROOT, '.tools/bin/yt-dlp')) ? join(ROOT, '.tools/bin/yt-dlp') : 'yt-dlp');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
const force = args.includes('--force');
const activate = args.includes('--activate');
const log = (...args) => console.log('[media]', ...args);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (d) => {
      stdout += d;
    });
    p.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-12000);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}: ${stderr}`))));
  });
}
const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
async function probe(file) {
  const p = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
  return {
    duration: Number(p.format.duration),
    video: p.streams.find((s) => s.codec_type === 'video'),
    audio: p.streams.find((s) => s.codec_type === 'audio'),
  };
}
async function state(id) {
  const file = join(DIST, '.state', `${id}.json`);
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
}
async function build(clip, output) {
  const hash = createHash('sha256')
    .update(JSON.stringify({ clip, output, version: 3 }))
    .digest('hex');
  const prev = await state(clip.id);
  const videoName = `${clip.id}-${hash.slice(0, 10)}.mp4`;
  const video = join(DIST, 'videos', videoName);
  if (
    !force &&
    prev?.hash === hash &&
    existsSync(video) &&
    existsSync(join(DIST, prev.entry.poster)) &&
    existsSync(join(DIST, 'thumbs', clip.id, '0.jpg'))
  ) {
    log(`${clip.id}: up to date`);
    return prev.entry;
  }
  const source = join(CACHE, `${clip.id}.mp4`);
  const infoPath = join(CACHE, `${clip.id}.info.json`);
  // yt-dlp resumes interrupted downloads. A source change must not reuse an old recording.
  const sourceKey = join(CACHE, `${clip.id}.url`);
  if (!existsSync(sourceKey) || (await readFile(sourceKey, 'utf8')) !== clip.youtube) {
    for (const name of await readdir(CACHE))
      if (name.startsWith(`${clip.id}.`)) await rm(join(CACHE, name), { force: true });
    await writeFile(sourceKey, clip.youtube);
  }
  const format = `bestvideo[vcodec^=avc1][height>=720][height<=${output.maxHeight}]+bestaudio[ext=m4a]/best[ext=mp4][height>=720][height<=${output.maxHeight}]`;
  const metadata = existsSync(infoPath)
    ? JSON.parse(await readFile(infoPath, 'utf8'))
    : JSON.parse(
        await run(YTDLP, [
          '--ignore-config',
          '--no-playlist',
          '--skip-download',
          '--dump-single-json',
          '--format',
          format,
          clip.youtube,
        ]),
      );
  const expectedBytes = Number(metadata.filesize ?? metadata.filesize_approx ?? 0);
  const disk = await statfs(ROOT);
  // Merging and fast-start remuxing temporarily need two copies, plus a free-space reserve.
  const requiredBytes = 2.1 * (expectedBytes || 2 * 1024 ** 3) + 4 * 1024 ** 3;
  if (disk.bavail * disk.bsize < requiredBytes)
    throw new Error(
      `Needs ${(requiredBytes / 1024 ** 3).toFixed(1)} GiB free for this full replay; free space or use another media location before retrying`,
    );
  log(`${clip.id}: downloading full replay (this can take several minutes)`);
  await run(YTDLP, [
    '--ignore-config',
    '--no-playlist',
    '--js-runtimes',
    'node',
    '--remote-components',
    'ejs:github',
    ...(process.env.MEDIA_DOWNLOADER
      ? ['--downloader', process.env.MEDIA_DOWNLOADER, '--downloader-args', 'aria2c:-x 8 -s 8 -k 1M']
      : []),
    '--concurrent-fragments',
    '8',
    '--retries',
    '3',
    '--fragment-retries',
    '3',
    '--socket-timeout',
    '30',
    '--format',
    format,
    '--merge-output-format',
    'mp4',
    '--write-info-json',
    '--no-progress',
    '--output',
    join(CACHE, `${clip.id}.%(ext)s`),
    clip.youtube,
  ]);
  const info = JSON.parse(await readFile(infoPath, 'utf8'));
  const original = await probe(source);
  if (original.duration < clip.minDurationSec || original.video?.height < 720 || !original.audio) {
    throw new Error(
      `${clip.id}: expected full replay >=${clip.minDurationSec}s, >=720p and audio; got ${original.duration}s / ${original.video?.height}p`,
    );
  }
  // Copy native frames and audio; preserve the broadcast cadence and 1× timeline.
  const temp = `${video}.tmp.mp4`;
  await ffmpeg(['-i', source, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', temp]);
  const result = await probe(temp);
  if (Math.abs(result.duration - original.duration) > 1) throw new Error(`${clip.id}: duration changed during remux`);
  await rename(temp, video);
  // Keep only the fast-start copy; full broadcasts otherwise double local disk use.
  await rm(source, { force: true });
  const poster = `posters/${clip.id}.jpg`;
  await ffmpeg([
    '-ss',
    String(clip.startOffsetSec),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    'scale=960:-2',
    '-q:v',
    '4',
    join(DIST, poster),
  ]);
  const thumbDir = join(DIST, 'thumbs', clip.id);
  await rm(thumbDir, { recursive: true, force: true });
  await mkdir(thumbDir, { recursive: true });
  await ffmpeg([
    '-skip_frame',
    'nokey',
    '-i',
    video,
    '-vf',
    `fps=1/${output.thumbnailIntervalSec}:round=down,scale=480:-2`,
    '-q:v',
    '5',
    '-start_number',
    '0',
    join(thumbDir, '%d.jpg'),
  ]);
  const entry = {
    id: clip.id,
    video: `videos/${videoName}`,
    poster,
    durationSec: result.duration,
    width: result.video.width,
    height: result.video.height,
    fps: result.video.avg_frame_rate,
    hasAudio: true,
    synthetic: false,
    startOffsetSec: clip.startOffsetSec,
    event: clip.event,
    thumbnails: {
      template: `thumbs/${clip.id}/{index}.jpg`,
      intervalSec: output.thumbnailIntervalSec,
      count: (await readdir(thumbDir)).filter((n) => n.endsWith('.jpg')).length,
    },
    credits: [
      {
        title: info.title,
        author: info.channel ?? info.uploader,
        license: info.license ?? 'YouTube standard license',
        licenseUrl: null,
        sourceUrl: clip.youtube,
      },
    ],
  };
  await writeFile(join(DIST, '.state', `${clip.id}.json`), JSON.stringify({ hash, entry }, null, 2));
  log(
    `${clip.id}: ready (${Math.round(result.duration / 60)} min, ${result.video.height}p, native ${result.video.avg_frame_rate} fps)`,
  );
  return entry;
}
async function main() {
  const sources = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));
  if (only && !sources.clips.some((c) => c.id === only)) throw new Error(`Unknown clip: ${only}`);
  for (const path of [CACHE, ...['videos', 'posters', 'thumbs', '.state'].map((p) => join(DIST, p))])
    await mkdir(path, { recursive: true });
  const catalogPath = join(DIST, 'catalog.json');
  const previous = existsSync(catalogPath) ? JSON.parse(await readFile(catalogPath, 'utf8')) : { clips: [] };
  const catalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    clips: previous.clips.filter((c) => sources.clips.some((s) => s.id === c.id)),
  };
  async function publishCatalog() {
    catalog.generatedAt = new Date().toISOString();
    await writeFile(`${catalogPath}.tmp`, JSON.stringify(catalog, null, 2));
    await rename(`${catalogPath}.tmp`, catalogPath);
    if (activate) {
      const now = new Date();
      await utimes(join(ROOT, '../apps/publisher/src/index.ts'), now, now);
      log('catalog activated; local publisher restart requested');
    }
  }
  const failures = [];
  for (const clip of sources.clips) {
    try {
      if (only && clip.id !== only) continue;
      const entry = await build(clip, sources.output);
      catalog.clips = catalog.clips.filter((c) => c.id !== clip.id);
      catalog.clips.push(entry);
      await publishCatalog();
    } catch (e) {
      failures.push(clip.id);
      console.error(`[media] ${clip.id}: ${e.message}`);
    }
  }
  await publishCatalog();
  await writeFile(
    join(DIST, 'CREDITS.md'),
    '# Demo replay sources\n\n' +
      catalog.clips.flatMap((c) => c.credits.map((x) => `- ${x.title} — ${x.author}: ${x.sourceUrl}`)).join('\n') +
      '\n',
  );
  log(
    `${catalog.clips.filter((c) => c.event).length} full replays available; ${failures.length} failures (previous media retained). Restart publisher to load the catalog.`,
  );
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => {
  console.error('[media]', e);
  process.exitCode = 1;
});

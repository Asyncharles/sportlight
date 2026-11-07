#!/usr/bin/env node
// Builds the demo media library from media/sources.json.
//
//  1. Resolves every Wikimedia Commons file through the Commons API (URL, author, licence).
//  2. Downloads the best web derivative (cached in media/.cache).
//  3. Transcodes each clip's segments into one 16:9 H.264/AAC MP4 with a 1s GOP (fast seeking,
//     seamless looping) plus a poster and a thumbnail strip used by "Best of Today".
//  4. Writes media/dist/catalog.json, which the mock publisher reads to describe feed sources.
//
// The build is incremental: a clip is only rebuilt when its definition changes. When a download
// fails (offline, rate-limited) a synthetic placeholder is generated so the demo still runs.
//
// Usage: node media/build.mjs [--force] [--only=clip-id]
// No npm dependencies; requires ffmpeg and ffprobe on PATH.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE = join(ROOT, '.cache');
const DIST = join(ROOT, 'dist');
const USER_AGENT = 'SportlightDemoMediaBuilder/1.0 (prototype; ffmpeg)';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const BUILD_VERSION = 2; // bump to invalidate all outputs when the encode recipe changes

const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const only = [...args].find((a) => a.startsWith('--only='))?.slice('--only='.length);

const log = (...m) => console.log('[media]', ...m);

async function main() {
  const sources = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));
  const out = sources.output;
  await mkdir(join(CACHE, 'downloads'), { recursive: true });
  await mkdir(join(DIST, 'videos'), { recursive: true });
  await mkdir(join(DIST, 'posters'), { recursive: true });
  await mkdir(join(DIST, 'thumbs'), { recursive: true });
  await mkdir(join(DIST, '.state'), { recursive: true });

  const titles = [...new Set(sources.clips.flatMap((c) => c.segments.map((s) => s.commons)))];
  const meta = await resolveCommons(titles);

  const catalog = { version: 1, generatedAt: new Date().toISOString(), clips: [] };
  for (const clip of sources.clips) {
    if (only && clip.id !== only) {
      const prev = await readState(clip.id);
      if (prev) catalog.clips.push(prev.entry);
      continue;
    }
    catalog.clips.push(await buildClip(clip, out, meta));
  }

  await writeFile(join(DIST, 'catalog.json'), JSON.stringify(catalog, null, 2));
  await writeFile(join(DIST, 'CREDITS.md'), renderCredits(catalog));
  log(`catalog written: ${catalog.clips.length} clips`);
}

// ---------------------------------------------------------------- Commons

async function resolveCommons(titles) {
  const cachePath = join(CACHE, 'commons-meta.json');
  const cached = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};
  const missing = titles.filter((t) => !cached[t]);
  for (let i = 0; i < missing.length; i += 20) {
    const batch = missing.slice(i, i + 20);
    const body = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      prop: 'videoinfo',
      viprop: 'url|size|derivatives|extmetadata',
      viextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|Credit',
      titles: batch.join('|'),
    });
    try {
      const res = await fetchWithRetry(COMMONS_API, { method: 'POST', body });
      const json = await res.json();
      const normalized = Object.fromEntries((json.query?.normalized ?? []).map((n) => [n.to, n.from]));
      for (const page of json.query?.pages ?? []) {
        const info = page.videoinfo?.[0];
        if (!info) continue;
        const md = info.extmetadata ?? {};
        const derivatives = info.derivatives ?? [];
        const pick =
          derivatives.find((d) => /\.720p\.vp9\.webm$/.test(d.src)) ??
          derivatives.find((d) => /\.480p\.vp9\.webm$/.test(d.src)) ??
          { src: info.url };
        cached[normalized[page.title] ?? page.title] = {
          title: page.title,
          downloadUrl: pick.src,
          pageUrl: info.descriptionurl,
          author: stripHtml(md.Artist?.value ?? 'Unknown'),
          license: md.LicenseShortName?.value ?? 'Unknown',
          licenseUrl: md.LicenseUrl?.value ?? null,
        };
      }
    } catch (err) {
      log(`Commons lookup failed (${err.message}); affected clips will use placeholders`);
    }
  }
  await writeFile(cachePath, JSON.stringify(cached, null, 2));
  return cached;
}

function stripHtml(s) {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, init = {}, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...init.headers } });
      if (res.status === 429 || res.status >= 500) {
        // Wikimedia rate-limits bursts; honour Retry-After when present.
        const retryAfter = Number(res.headers.get('retry-after'));
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : 0 });
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return res;
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await sleep(Math.max(err.retryAfterMs ?? 0, 5000 * 2 ** i));
    }
  }
  throw lastErr;
}

async function download(entry) {
  const ext = entry.downloadUrl.split('.').pop().split('?')[0];
  const file = join(CACHE, 'downloads', `${sha1(entry.downloadUrl).slice(0, 16)}.${ext}`);
  if (existsSync(file)) return file;
  // Pace downloads to stay within Wikimedia's anonymous rate limits.
  await sleep(1500);
  log(`downloading ${entry.title}`);
  const res = await fetchWithRetry(entry.downloadUrl);
  const tmp = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  await rename(tmp, file);
  return file;
}

// ---------------------------------------------------------------- Build

async function readState(id) {
  const p = join(DIST, '.state', `${id}.json`);
  return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null;
}

async function buildClip(clip, out, meta) {
  const hash = sha1(JSON.stringify({ clip, out, v: BUILD_VERSION }));
  const prev = await readState(clip.id);
  const video = join(DIST, 'videos', `${clip.id}.mp4`);
  // Placeholders are always retried so a later online build picks up the real footage.
  if (!force && prev?.hash === hash && !prev.entry.synthetic && existsSync(video)) {
    log(`${clip.id}: up to date`);
    return prev.entry;
  }

  const inputs = [];
  let synthetic = false;
  for (const seg of clip.segments) {
    const m = meta[seg.commons];
    if (!m) {
      synthetic = true;
      break;
    }
    try {
      const file = await download(m);
      const probe = await ffprobe(file);
      inputs.push({ file, seg, probe, meta: m });
    } catch (err) {
      log(`${clip.id}: download failed for ${seg.commons}: ${err.message}`);
      synthetic = true;
      break;
    }
  }

  const tmpVideo = `${video}.tmp.mp4`;
  if (synthetic) {
    log(`${clip.id}: generating synthetic placeholder`);
    await ffmpeg([
      '-f', 'lavfi', '-i', `testsrc2=size=${out.width}x${out.height}:rate=${out.fps}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '60', ...encodeArgs(out), tmpVideo,
    ]);
  } else {
    log(`${clip.id}: transcoding ${inputs.length} segment(s)`);
    await ffmpeg(transcodeArgs(inputs, out, tmpVideo));
  }
  await rename(tmpVideo, video);

  const probe = await ffprobe(video);
  const durationSec = Math.round(probe.duration * 1000) / 1000;

  // Poster and thumbnail strip.
  const poster = join(DIST, 'posters', `${clip.id}.jpg`);
  await ffmpeg(['-ss', String(Math.min(durationSec * 0.3, 8)), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', poster]);
  const thumbDir = join(DIST, 'thumbs', clip.id);
  await rm(thumbDir, { recursive: true, force: true });
  await mkdir(thumbDir, { recursive: true });
  const interval = out.thumbnailIntervalSec;
  await ffmpeg(['-i', video, '-vf', `fps=1/${interval}:round=down,scale=480:-2`, '-q:v', '5', '-start_number', '0', join(thumbDir, '%d.jpg')]);
  const thumbCount = (await readdir(thumbDir)).filter((f) => f.endsWith('.jpg')).length;

  const entry = {
    id: clip.id,
    video: `videos/${clip.id}.mp4`,
    poster: `posters/${clip.id}.jpg`,
    durationSec,
    width: out.width,
    height: out.height,
    hasAudio: synthetic ? false : inputs.some((i) => i.probe.hasAudio),
    synthetic,
    thumbnails: { template: `thumbs/${clip.id}/{index}.jpg`, intervalSec: interval, count: thumbCount },
    credits: synthetic
      ? []
      : dedupeBy(
          inputs.map((i) => ({
            title: i.meta.title.replace(/^File:/, ''),
            author: i.meta.author,
            license: i.meta.license,
            licenseUrl: i.meta.licenseUrl,
            sourceUrl: i.meta.pageUrl,
          })),
          (c) => c.title,
        ),
  };
  await writeFile(join(DIST, '.state', `${clip.id}.json`), JSON.stringify({ hash, entry }, null, 2));
  log(`${clip.id}: done (${durationSec.toFixed(1)}s)`);
  return entry;
}

function transcodeArgs(inputs, out, dest) {
  const args = [];
  inputs.forEach(({ file, seg }) => {
    if (seg.start) args.push('-ss', String(seg.start));
    if (seg.duration) args.push('-t', String(seg.duration));
    args.push('-i', file);
  });
  // One silent source shared by segments without audio.
  const silentIdx = inputs.length;
  args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');

  const filters = [];
  const concatIn = [];
  inputs.forEach(({ seg, probe }, i) => {
    const dur = seg.duration ?? Math.max(0.1, probe.duration - (seg.start ?? 0));
    filters.push(
      `[${i}:v]scale=${out.width}:${out.height}:force_original_aspect_ratio=increase,` +
        `crop=${out.width}:${out.height},fps=${out.fps},setsar=1,format=yuv420p,` +
        `trim=duration=${dur},setpts=PTS-STARTPTS[v${i}]`,
    );
    if (probe.hasAudio) {
      filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${dur},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      filters.push(`[${silentIdx}:a]atrim=duration=${dur},asetpts=PTS-STARTPTS[a${i}]`);
    }
    concatIn.push(`[v${i}][a${i}]`);
  });
  filters.push(`${concatIn.join('')}concat=n=${inputs.length}:v=1:a=1[v][a]`);
  return [...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', ...encodeArgs(out), dest];
}

function encodeArgs(out) {
  return [
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    // 1-second closed GOPs: cheap seeks for live-edge sync, highlight replay and promotion.
    '-g', String(out.fps), '-keyint_min', String(out.fps), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
    '-shortest', '-movflags', '+faststart', '-y',
  ];
}

// ---------------------------------------------------------------- helpers

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}: ${stderr.split('\n').slice(-6).join('\n')}`)),
    );
  });
}

const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);

async function ffprobe(file) {
  const json = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  return {
    duration: Number(json.format?.duration ?? 0),
    hasAudio: (json.streams ?? []).some((s) => s.codec_type === 'audio'),
  };
}

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

function dedupeBy(list, key) {
  const seen = new Set();
  return list.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

function renderCredits(catalog) {
  const lines = ['# Demo media credits', '', 'Footage from Wikimedia Commons, transcoded and trimmed for the Sportlight prototype.', ''];
  for (const clip of catalog.clips) {
    lines.push(`## ${clip.id}`);
    if (clip.synthetic) lines.push('- Synthetic placeholder (ffmpeg test source).');
    for (const c of clip.credits) lines.push(`- "${c.title}" by ${c.author}, ${c.license} — ${c.sourceUrl}`);
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('[media] build failed:', err);
  process.exit(1);
});

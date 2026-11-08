import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { getCompetition, getSport, type CaptionCue, type Highlight } from '@sportlight/shared';

/**
 * Branded graphics for vertical Shorts, drawn as transparent PNGs and composited by FFmpeg. Drawing
 * text here (rather than with FFmpeg's drawtext/libass) keeps the brand font and layout identical on
 * every FFmpeg build, including ones compiled without freetype or libass.
 */

export const FRAME = { width: 1080, height: 1920 } as const;
/** The source video window: 16:9, inset with rounded corners. */
export const VIDEO = { x: 40, y: 610, width: 1000, height: 562, radius: 34 } as const;
/** Commentary cards sit below the video, clear of YouTube's bottom and right-hand UI. */
export const CUES = { y: 1222, width: 1080, height: 290 } as const;

const INK = '#171917';
const LIME = '#C5FF00';
const PAPER = '#F7F8F4';

/** Repository root in development (src/) and in the image (dist/): both are four levels up. */
const ROOT = process.env.CONTENT_ASSETS_DIR || fileURLToPath(new URL('../../../../', import.meta.url));
let fontsReady = false;
function fonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(join(ROOT, 'fonts', 'Manrope.ttf'), 'Manrope');
  GlobalFonts.registerFromPath(join(ROOT, 'fonts', 'IBMPlexMono-Regular.ttf'), 'Plex Mono');
  fontsReady = true;
}

export interface OverlaySet {
  under: string;
  mask: string;
  chrome: string;
  cues: Array<CaptionCue & { file: string }>;
}

/** Writes every graphic for one Short into `dir`. */
export async function renderOverlays(h: Highlight, dir: string, durationSec: number): Promise<OverlaySet> {
  fonts();
  const under = join(dir, 'under.png');
  const mask = join(dir, 'mask.png');
  const chrome = join(dir, 'chrome.png');
  await writeFile(under, drawUnder());
  await writeFile(mask, drawMask());
  await writeFile(chrome, await drawChrome(h));
  const cues = timedCues(h, durationSec);
  const files = await Promise.all(
    cues.map(async (cue, i) => {
      const file = join(dir, `cue-${i}.png`);
      await writeFile(file, drawCue(cue.text, cue.commentary));
      return { start: cue.start, end: cue.end, text: cue.text, file };
    }),
  );
  return { under, mask, chrome, cues: files };
}

/** Transcribed commentary when present; otherwise the description as one editorial card. */
export function timedCues(h: Highlight, durationSec: number) {
  const commentary = (h.caption?.commentary ?? [])
    .filter((c) => c.end > c.start && c.start < durationSec)
    .map((c) => ({ start: c.start, end: Math.min(c.end, durationSec), text: c.text, commentary: true }));
  if (commentary.length) return commentary;
  const description = h.caption?.model !== 'template' ? h.caption?.description : undefined;
  if (!description || durationSec < 3) return [];
  return [{ start: 0.8, end: durationSec - 0.3, text: description, commentary: false }];
}

function drawUnder() {
  const canvas = createCanvas(FRAME.width, FRAME.height);
  const ctx = canvas.getContext('2d');
  // Legibility scrims over the blurred backdrop.
  // One continuous gradient, so no seams appear beside the video.
  const scrim = ctx.createLinearGradient(0, 0, 0, FRAME.height);
  scrim.addColorStop(0, 'rgba(23,25,23,0.86)');
  scrim.addColorStop(0.3, 'rgba(23,25,23,0.62)');
  scrim.addColorStop(0.62, 'rgba(23,25,23,0.62)');
  scrim.addColorStop(1, 'rgba(23,25,23,0.92)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, FRAME.width, FRAME.height);
  // Soft drop shadow lifting the video off the backdrop.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 18;
  ctx.fillStyle = INK;
  roundRect(ctx, VIDEO.x, VIDEO.y, VIDEO.width, VIDEO.height, VIDEO.radius);
  ctx.fill();
  ctx.restore();
  return canvas.toBuffer('image/png');
}

function drawMask() {
  const canvas = createCanvas(VIDEO.width, VIDEO.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, VIDEO.width, VIDEO.height);
  ctx.fillStyle = '#fff';
  roundRect(ctx, 0, 0, VIDEO.width, VIDEO.height, VIDEO.radius);
  ctx.fill();
  return canvas.toBuffer('image/png');
}

async function drawChrome(h: Highlight) {
  const canvas = createCanvas(FRAME.width, FRAME.height);
  const ctx = canvas.getContext('2d');
  const cx = FRAME.width / 2;

  // Logo, below YouTube's top controls.
  const logo = await loadImage(join(ROOT, 'logos', 'sportlight-white.png'));
  const logoWidth = 360;
  const logoHeight = (logo.height / logo.width) * logoWidth;
  ctx.drawImage(logo, cx - logoWidth / 2, 150, logoWidth, logoHeight);

  // Sport · competition pill.
  const sport = getSport(h.sportId)?.name ?? h.sportId;
  const competition = getCompetition(h.event.competitionId)?.name;
  const pill = [sport, competition].filter(Boolean).join('  ·  ').toUpperCase();
  ctx.font = '600 26px "Plex Mono"';
  const pillWidth = Math.min(900, ctx.measureText(pill).width + 56);
  ctx.fillStyle = 'rgba(197,255,0,0.14)';
  roundRect(ctx, cx - pillWidth / 2, 300, pillWidth, 52, 26);
  ctx.fill();
  ctx.strokeStyle = 'rgba(197,255,0,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = LIME;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, pill, pillWidth - 40), cx, 327);

  // Title: up to two lines, sized down when long.
  const title = h.caption?.model !== 'template' && h.caption?.title ? h.caption.title : h.event.title;
  let size = 66;
  let lines: string[] = [];
  for (; size >= 48; size -= 4) {
    ctx.font = `800 ${size}px Manrope`;
    lines = wrap(ctx, title, 960);
    if (lines.length <= 2) break;
  }
  lines = clampLines(ctx, lines, 2, 960);
  ctx.fillStyle = PAPER;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 16;
  const lineHeight = size * 1.12;
  const titleTop = lines.length === 1 ? 445 : 410;
  lines.forEach((line, i) => ctx.fillText(line, cx, titleTop + i * lineHeight));
  ctx.shadowBlur = 0;

  // Fixture line under the title.
  const fixture = [h.event.title, h.event.subtitle].filter(Boolean).join('  ·  ');
  ctx.font = '500 30px Manrope';
  ctx.fillStyle = 'rgba(247,248,244,0.72)';
  ctx.fillText(fit(ctx, title === h.event.title ? (h.event.subtitle ?? '') : fixture, 940), cx, 572);

  // Hairline frame on the video.
  ctx.strokeStyle = 'rgba(247,248,244,0.16)';
  ctx.lineWidth = 2;
  roundRect(ctx, VIDEO.x + 1, VIDEO.y + 1, VIDEO.width - 2, VIDEO.height - 2, VIDEO.radius);
  ctx.stroke();

  // Peak intensity badge, overlapping the video's lower-left corner.
  const peak = `PEAK ${Math.round(h.peak.score)}`;
  ctx.font = '600 28px "Plex Mono"';
  const badgeWidth = ctx.measureText(peak).width + 44;
  const badgeY = VIDEO.y + VIDEO.height - 26;
  ctx.fillStyle = LIME;
  roundRect(ctx, VIDEO.x + 28, badgeY, badgeWidth, 52, 26);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(peak, VIDEO.x + 50, badgeY + 27);
  return canvas.toBuffer('image/png');
}

/** One caption card: transcribed commentary in quotes, or an editorial description. */
function drawCue(text: string, commentary: boolean) {
  const canvas = createCanvas(CUES.width, CUES.height);
  const ctx = canvas.getContext('2d');
  const maxText = 800;
  let size = commentary ? 54 : 44;
  let lines: string[] = [];
  // Prefer two lines, shrinking the type; very long cues fall back to three lines at the smallest size.
  for (; size >= 40; size -= 2) {
    ctx.font = `${commentary ? 800 : 600} ${size}px Manrope`;
    lines = wrap(ctx, commentary ? `“${text}”` : text, maxText);
    if (lines.length <= 2) break;
  }
  size = Math.max(size, 40);
  ctx.font = `${commentary ? 800 : 600} ${size}px Manrope`;
  lines = clampLines(ctx, wrap(ctx, commentary ? `“${text}”` : text, maxText), 3, maxText);
  const lineHeight = size * 1.22;
  const label = commentary ? 'COMMENTARY' : 'THE MOMENT';
  const padX = 44;
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.font = '600 22px "Plex Mono"';
  const boxWidth = Math.min(900, Math.max(textWidth, ctx.measureText(label).width) + padX * 2 + 8);
  const boxHeight = 64 + lines.length * lineHeight + 22;
  const x = (CUES.width - boxWidth) / 2;
  const y = 12;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = 'rgba(23,25,23,0.9)';
  roundRect(ctx, x, y, boxWidth, boxHeight, 24);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = LIME;
  roundRect(ctx, x, y + 22, 7, boxHeight - 44, 3.5);
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = LIME;
  ctx.font = '600 22px "Plex Mono"';
  ctx.fillText(label, x + padX + 8, y + 50);
  ctx.fillStyle = PAPER;
  ctx.font = `${commentary ? 800 : 600} ${size}px Manrope`;
  lines.forEach((line, i) => ctx.fillText(line, x + padX + 8, y + 64 + size + i * lineHeight - 6));
  return canvas.toBuffer('image/png');
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function wrap(ctx: SKRSContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function clampLines(ctx: SKRSContext2D, lines: string[], max: number, width: number) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = fit(ctx, `${kept[max - 1]} ${lines.slice(max).join(' ')}`, width);
  return kept;
}

function fit(ctx: SKRSContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > width) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

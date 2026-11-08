import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Highlight } from '@sportlight/shared';
import { CaptionError } from './captioner.js';
import { LocalCaptioner } from './local-captioner.js';

const dir = mkdtempSync(join(tmpdir(), 'local-captioner-test-'));
const clip = join(dir, 'clip.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=8', '-t', '4', '-pix_fmt', 'yuv420p', clip]);
const media = { mimeType: 'video/mp4' as const, base64: readFileSync(clip).toString('base64') };
const h = { sportId: 'football', clip: { mediaStart: 10, mediaEnd: 14, durationSec: 4 }, event: { title: 'A v B' } } as unknown as Highlight;

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe('LocalCaptioner', () => {
  it('sends evenly spaced stills with a JSON schema and parses the reply', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"title":"Test card","description":"A test pattern.","tags":["test"]}' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const c = new LocalCaptioner({ endpoint: 'http://local:1', model: 'm', ffmpegPath: 'ffmpeg', frames: 4 });
    const draft = await c.caption(h, media, new AbortController().signal);
    expect(draft).toEqual({ title: 'Test card', description: 'A test pattern.', tags: ['test'] });
    expect(c.name).toBe('local/m');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://local:1/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe('json_schema');
    const images = body.messages[1].content.filter((p: { type: string }) => p.type === 'image_url');
    expect(images).toHaveLength(4);
    expect(images[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('asks the queue to pause when the server is not running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const c = new LocalCaptioner({ endpoint: 'http://local:1', model: 'm', ffmpegPath: 'ffmpeg', frames: 2 });
    const err = await c.caption(h, media, new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(CaptionError);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBeGreaterThan(120_000);
  });
});

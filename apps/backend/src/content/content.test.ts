import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Highlight } from '@sportlight/shared';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { ContentStore, overlaps, publicJob, seal, unseal } from './store.js';
import { googleFetch, GoogleError, uploadMetadata, resumeUpload } from './google.js';
import { shortFilter, sourceUrl } from './renderer.js';
import { timedCues } from './overlays.js';
import { alignCues, speechSegments } from './speech.js';
import { dtwPreset, tokensToWords, wordsToCues } from './transcribe.js';
import { ContentService, isQuotaError, nextPacificMidnight } from './service.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'sportlight-content-'));
  directories.push(dir);
  return dir;
}
function highlight(id = 'abcdef123456', start = 10): Highlight {
  return {
    id,
    day: '2026-11-07',
    feedId: 'football',
    runId: 'run',
    sportId: 'football',
    event: { title: 'France vs Germany' },
    source: { kind: 'looping-mp4', url: '/media/game.mp4', durationSec: 200, offsetSec: 0 },
    clip: { streamStart: start, streamEnd: start + 20, mediaStart: start, mediaEnd: start + 20, durationSec: 20 },
    peak: { score: 95, streamTime: start + 10, at: '2026-11-07T12:00:00Z' },
    startedAt: '2026-11-07T12:00:00Z',
    curve: [],
  } as Highlight;
}
async function service(highlights: Highlight[] = []) {
  const dir = await directory();
  const config = loadConfig({
    DATA_DIR: dir,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    CONTENT_ENCRYPTION_KEY: 'ab'.repeat(32),
    CONTENT_ALLOWED_EMAILS: 'owner@example.com',
  });
  const svc = new ContentService(config, () => highlights, createLogger('test'));
  await svc.init();
  return svc;
}

describe('publishing safety and persistence', () => {
  it('reads real HTTP 308 upload progress without following redirects', async () => {
    let redirected = false;
    const server = createServer((req, res) => {
      if (req.url === '/progress') {
        res.writeHead(308, { Range: 'bytes=0-3' }).end();
      } else if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/destination' }).end();
      } else {
        redirected = true;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const response = await googleFetch(`${base}/progress`, { method: 'PUT' });
      expect(response.status).toBe(308);
      expect(response.headers.get('range')).toBe('bytes=0-3');
      await expect(googleFetch(`${base}/redirect`)).rejects.toBeInstanceOf(GoogleError);
      expect(redirected).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('encrypts credentials and rejects another key', () => {
    const key = 'ab'.repeat(32);
    const sealed = seal('secret refresh token', key);
    expect(sealed).not.toContain('secret');
    expect(unseal(sealed, key)).toBe('secret refresh token');
    expect(() => unseal(sealed, 'cd'.repeat(32))).toThrow();
  });
  it('requests public uploads without scheduled release or review', () => {
    const metadata = uploadMetadata(highlight());
    expect(metadata.status).toEqual({ privacyStatus: 'public', selfDeclaredMadeForKids: false });
    expect(metadata.snippet.title).toContain('#Shorts');
  });
  it('deduplicates overlapping footage across runs and IDs', () => {
    expect(overlaps(highlight('one'), { ...highlight('two', 15), runId: 'other' })).toBe(true);
    expect(overlaps(highlight('one'), highlight('two', 60))).toBe(false);
  });
  it('maps only the configured media origin', () => {
    expect(sourceUrl(highlight(), 'http://media:8080', '/media')).toBe('http://media:8080/game.mp4');
    expect(sourceUrl(highlight(), 'http://localhost:5173/media', '/media')).toBe(
      'http://localhost:5173/media/game.mp4',
    );
    const h = highlight();
    h.source.url = 'http://169.254.169.254/secrets.mp4';
    expect(() => sourceUrl(h, 'http://media:8080', '/media')).toThrow();
  });
  it('retains upload sessions on restart and hides them from API responses', async () => {
    const dir = await directory();
    const store = new ContentStore(dir);
    await store.init();
    store.state.jobs.push({
      id: 'job',
      channelId: 'channel',
      highlight: highlight(),
      status: 'uploading',
      uploadSession: 'encrypted',
      createdAt: 1,
      updatedAt: 1,
      readyAt: 1,
      attempts: 1,
      rendered: true,
    });
    await store.save();
    const restored = new ContentStore(dir);
    await restored.init();
    expect(restored.state.jobs[0]?.status).toBe('uploading');
    expect(restored.state.jobs[0]?.uploadSession).toBe('encrypted');
    expect(publicJob(restored.state.jobs[0]!)).not.toHaveProperty('uploadSession');
  });
  it('queues new moments while paused and suppresses repeated media', async () => {
    const svc = await service([highlight('first'), highlight('duplicate', 12)]);
    svc.store.state.connection = {
      id: 'channel',
      title: 'Test',
      email: 'owner@example.com',
      name: 'Owner',
      refreshToken: 'encrypted',
    };
    svc.store.state.settings.enabled = false;
    await svc.tick();
    expect(svc.store.state.jobs.map((j) => j.status)).toEqual(['queued', 'skipped']);
    expect(svc.store.state.jobs[0]?.readyAt).toBeGreaterThan(Date.now());
    await svc.tick();
    expect(svc.store.state.jobs).toHaveLength(2);
    await svc.stop();
  });
  it('skips clips still queued for a previously connected channel', async () => {
    const svc = await service([highlight()]);
    svc.store.state.connection = {
      id: 'channel',
      title: 'Test',
      email: 'owner@example.com',
      name: 'Owner',
      refreshToken: 'encrypted',
    };
    svc.store.state.seen = [highlight().id];
    svc.store.state.jobs.push({
      id: 'old',
      highlight: highlight(),
      channelId: 'previous',
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      readyAt: Date.now(),
      attempts: 0,
      rendered: false,
    });
    await svc.tick();
    expect(svc.store.state.jobs[0]?.status).toBe('skipped');
    expect(svc.store.state.jobs[0]?.message).toMatch(/different channel/);
    await svc.stop();
  });
  it('reports the active job, or the next job and when its upload slot opens', async () => {
    const svc = await service([]);
    svc.store.state.connection = {
      id: 'channel',
      title: 'Test',
      email: 'owner@example.com',
      name: 'Owner',
      refreshToken: 'encrypted',
    };
    const now = Date.now();
    const job = (id: string, extra: object) => ({
      id,
      highlight: highlight(id),
      channelId: 'channel',
      createdAt: now,
      updatedAt: now,
      readyAt: now - 1000,
      attempts: 0,
      rendered: false,
      ...extra,
    });
    svc.store.state.jobs.push(
      job('done', { status: 'published', uploadStartedAt: now - 5 * 60_000 }) as never,
      job('next', { status: 'queued' }) as never,
    );
    expect(svc.schedule(now)).toEqual({
      state: 'waiting',
      jobId: 'next',
      reason: 'interval',
      nextAt: now + 10 * 60_000,
    });
    svc.store.state.jobs[1]!.status = 'rendering';
    expect(svc.schedule(now)).toEqual({ state: 'working', jobId: 'next' });
    svc.store.state.jobs[1]!.status = 'skipped';
    expect(svc.schedule(now)).toEqual({ state: 'idle' });
    await svc.stop();
  });
  it('does not create jobs for the archive recorded at connection', async () => {
    const svc = await service([highlight()]);
    svc.store.state.connection = {
      id: 'channel',
      title: 'Test',
      email: 'owner@example.com',
      name: 'Owner',
      refreshToken: 'encrypted',
    };
    svc.store.state.seen = [highlight().id];
    await svc.tick();
    expect(svc.store.state.jobs).toHaveLength(0);
    await svc.stop();
  });
  it('resumes from the server offset without creating a second upload', async () => {
    const file = join(await directory(), 'video.mp4');
    await writeFile(file, 'abcdefgh');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { range: 'bytes=0-3' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'video123', status: { privacyStatus: 'public' } }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetch);
    const result = await resumeUpload('token', 'https://www.googleapis.com/session', file);
    expect(result.id).toBe('video123');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1].headers['Content-Range']).toBe('bytes */8');
    expect(fetch.mock.calls[1]?.[1].headers['Content-Range']).toBe('bytes 4-7/8');
    expect(Buffer.from(fetch.mock.calls[1]?.[1].body).toString()).toBe('efgh');
  });
  it('recognizes an already completed resumable upload without sending bytes again', async () => {
    const file = join(await directory(), 'video.mp4');
    await writeFile(file, 'abcdefgh');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'already-uploaded' })));
    vi.stubGlobal('fetch', fetch);
    expect((await resumeUpload('token', 'https://www.googleapis.com/session', file)).id).toBe('already-uploaded');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requires a session and validates OAuth browser state before exchanging any code', async () => {
    const svc = await service();
    const server = createServer((req, res) => {
      void svc.route(req, res, new URL(req.url!, 'http://localhost'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const snapshot = await (await fetch(`${base}/api/content/session`)).json();
      expect(snapshot.authenticated).toBe(false);
      expect(snapshot).not.toHaveProperty('jobs');
      expect((await fetch(`${base}/api/content/settings`, { method: 'POST' })).status).toBe(401);
      const response = await fetch(`${base}/api/content/auth/callback?state=forged&code=stolen`, {
        redirect: 'manual',
      });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toContain('auth=failed');
      const start = await fetch(`${base}/api/content/auth/start`, { redirect: 'manual' });
      const location = new URL(start.headers.get('location')!);
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('access_type')).toBe('offline');
      expect(start.headers.get('set-cookie')).toContain('HttpOnly');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await svc.stop();
    }
  });
  it('connects an allowed account, protects mutations, and publishes a queued clip through processing', async () => {
    const archive = highlight('archive');
    const moments = [archive];
    const svc = await service(moments);
    const nativeFetch = globalThis.fetch;
    let uploadBody: Record<string, unknown> | undefined;
    const google = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:')) return nativeFetch(input, init);
      if (url.includes('oauth2.googleapis.com/token'))
        return new Response(
          JSON.stringify({
            access_token: 'access',
            refresh_token: 'refresh',
            scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
          }),
        );
      if (url.includes('/userinfo'))
        return new Response(JSON.stringify({ email: 'owner@example.com', email_verified: true, name: 'Owner' }));
      if (url.includes('/channels?'))
        return new Response(JSON.stringify({ items: [{ id: 'channel', snippet: { title: 'Test channel' } }] }));
      if (url.includes('/upload/youtube')) {
        uploadBody = JSON.parse(String(init?.body));
        return new Response(null, { headers: { location: 'https://www.googleapis.com/session' } });
      }
      if (url.endsWith('/session'))
        return new Response(JSON.stringify({ id: 'uploaded', status: { privacyStatus: 'public' } }));
      if (url.includes('/videos?'))
        return new Response(
          JSON.stringify({ items: [{ status: { privacyStatus: 'public', uploadStatus: 'processed' } }] }),
        );
      throw new Error('Unexpected network request in test');
    });
    vi.stubGlobal('fetch', google);
    const server = createServer((req, res) => {
      void svc.route(req, res, new URL(req.url!, 'http://localhost'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const start = await fetch(`${base}/api/content/auth/start`, { redirect: 'manual' });
      const state = new URL(start.headers.get('location')!).searchParams.get('state');
      const callback = await fetch(`${base}/api/content/auth/callback?state=${state}&code=test`, {
        redirect: 'manual',
        headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! },
      });
      expect(callback.headers.get('location')).toBe('http://localhost:5173/dashboard');
      const cookie = callback.headers.get('set-cookie')!.split(';')[0]!;
      const overview = await (await fetch(`${base}/api/content/session`, { headers: { cookie } })).json();
      expect(overview.authenticated).toBe(true);
      expect(overview.channel.title).toBe('Test channel');
      expect(JSON.stringify(overview)).not.toContain('refresh');
      expect(
        (
          await fetch(`${base}/api/content/settings`, {
            method: 'POST',
            headers: { cookie, origin: 'https://evil.example' },
          })
        ).status,
      ).toBe(403);
      const settings = { enabled: true, minPeak: 90, dailyLimit: 0, intervalMinutes: 0 };
      expect(
        (
          await fetch(`${base}/api/content/settings`, {
            method: 'POST',
            headers: { cookie, origin: 'http://localhost:5173', 'x-csrf-token': overview.csrf },
            body: JSON.stringify(settings),
          })
        ).status,
      ).toBe(200);
      await svc.tick();
      expect(svc.store.state.jobs).toHaveLength(0);
      moments.push(highlight('new', 80));
      await svc.tick();
      const job = svc.store.state.jobs[0]!;
      expect(job.status).toBe('queued');
      job.rendered = true;
      job.readyAt = 0;
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(svc.store.dir, job.id));
      await writeFile(join(svc.store.dir, job.id, 'short.mp4'), 'test video');
      await svc.tick();
      expect(job.status).toBe('processing');
      expect(job.videoId).toBe('uploaded');
      expect(uploadBody?.status).toEqual({ privacyStatus: 'public', selfDeclaredMadeForKids: false });
      job.nextPollAt = 0;
      await svc.tick();
      expect(job.status).toBe('published');
      moments.push(highlight('repeat', 82));
      await svc.tick();
      expect(svc.store.state.jobs[1]?.status).toBe('skipped');
      // Replaying the same callback cannot obtain another dashboard session.
      const replay = await fetch(`${base}/api/content/auth/callback?state=${state}&code=test`, {
        redirect: 'manual',
        headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! },
      });
      expect(replay.headers.get('location')).toContain('auth=failed');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await svc.stop();
    }
  });
});

describe('premium Shorts', () => {
  it('composites backdrop, rounded video, chrome and each timed cue', () => {
    const graph = shortFilter(20, [
      { start: 1, end: 4 },
      { start: 5, end: 9 },
    ]);
    expect(graph).toContain('alphamerge');
    expect(graph).toContain("[l0][cue0]overlay=0:1222:format=auto:enable='between(t,1.000,4.000)'[l1]");
    expect(graph).toContain('[5:v]format=rgba');
    expect(graph).toContain('[l2]fade=t=in:st=0:d=0.35,fade=t=out:st=19.600');
  });
  it('captions commentary, else a model description, never a template', () => {
    const h = highlight();
    h.caption = { title: 't', description: 'Template text', tags: [], model: 'template', generatedAt: '' };
    expect(timedCues(h, 20)).toEqual([]);
    h.caption = { ...h.caption, model: 'gemini', description: 'A low drive beats the keeper.' };
    expect(timedCues(h, 20)).toEqual([{ start: 0.8, end: 19.7, text: 'A low drive beats the keeper.', commentary: false }]);
    h.caption.commentary = [
      { start: 1, end: 3, text: 'He shoots!' },
      { start: 19, end: 25, text: 'What a goal' },
      { start: 22, end: 24, text: 'after the end' },
    ];
    expect(timedCues(h, 20)).toEqual([
      { start: 1, end: 3, text: 'He shoots!', commentary: true },
      { start: 19, end: 20, text: 'What a goal', commentary: true },
    ]);
  });
  it('waits for YouTube quota resets instead of failing jobs', () => {
    expect(isQuotaError(new GoogleError(403, 'quotaExceeded'))).toBe(true);
    expect(isQuotaError(new GoogleError(400, 'uploadLimitExceeded'))).toBe(true);
    expect(isQuotaError(new GoogleError(403, 'forbidden'))).toBe(false);
    // 2026-11-07 10:00 PST → next reset 2026-11-08 00:00 PST (+1 minute margin).
    const now = Date.parse('2026-11-07T18:00:00Z');
    expect(new Date(nextPacificMidnight(now)).toISOString()).toBe('2026-11-08T08:01:00.000Z');
  });
});

describe('caption sync', () => {
  const speech = [
    { start: 0, end: 1.85 },
    { start: 2.35, end: 6.15 },
    { start: 7.2, end: 9.35 },
    { start: 15.1, end: 16.6 },
  ];
  it('snaps drifted model timings to spoken onsets and pauses', () => {
    expect(
      alignCues(
        [
          { start: 0.8, end: 3.4, text: 'a' },
          { start: 3.4, end: 7.0, text: 'b' },
          { start: 6.2, end: 9.0, text: 'c' },
          { start: 14.1, end: 17.4, text: 'd' },
        ],
        speech,
        20,
      ),
    ).toEqual([
      { start: 0, end: 3.4, text: 'a' },
      { start: 3.4, end: 6.55, text: 'b' },
      { start: 7.2, end: 9.75, text: 'c' },
      { start: 15.1, end: 17, text: 'd' },
    ]);
  });
  it('keeps model timings when no speech is detected', () => {
    const cues = [{ start: 1, end: 2, text: 'x' }];
    expect(alignCues(cues, [], 10)).toBe(cues);
  });
  it('finds voiced segments above the crowd floor', () => {
    const levels = [...Array(20).fill(50), ...Array(30).fill(66), ...Array(20).fill(50), ...Array(10).fill(65)];
    expect(speechSegments(levels)).toEqual([
      { start: 1, end: 2.5 },
      { start: 3.5, end: 4 },
    ]);
  });
});

describe('whisper commentary', () => {
  it('derives the DTW preset from the model file', () => {
    expect(dtwPreset('/m/ggml-small.bin')).toBe('small');
    expect(dtwPreset('ggml-base.en.bin')).toBe('base.en');
    expect(dtwPreset('ggml-large-v3-turbo-q5_0.bin')).toBe('large.v3.turbo');
  });
  it('builds timed words, ignoring prompt echoes, late punctuation and noise outside speech', () => {
    const tok = (text: string, t: number, p = 0.9) => ({ text, t_dtw: t * 100, p });
    const words = tokensToWords(
      [
        { text: '[_BEG_]', t_dtw: 0 },
        tok(' Cup', 0),
        tok(' Final', 0),
        tok(' World', 0),
        tok(' Here', 1.0),
        tok(' comes', 1.3),
        tok(' Mb', 1.7),
        tok('appé', 1.9),
        tok('.', 3.0),
        tok(' Thanks', 8.0),
      ],
      [{ start: 0.9, end: 2.2 }],
      10,
    );
    expect(words).toEqual([
      { start: 1, end: 1.3, text: 'Here' },
      { start: 1.3, end: 1.65, text: 'comes' },
      { start: 1.7, end: 2.25, text: 'Mbappé.' },
    ]);
  });
  it('groups words into readable cues split at pauses and clause ends', () => {
    const cues = wordsToCues(
      [
        { start: 0, end: 0.4, text: 'Messi' },
        { start: 0.4, end: 0.8, text: 'six,' },
        { start: 0.8, end: 1.2, text: 'Mbappé' },
        { start: 1.2, end: 1.6, text: 'five.' },
        { start: 4, end: 4.5, text: 'Moved' },
        { start: 4.5, end: 5, text: 'out.' },
      ],
      10,
    );
    expect(cues).toEqual([
      { start: 0, end: 2, text: 'Messi six, Mbappé five.' },
      { start: 4, end: 5.4, text: 'Moved out.' },
    ]);
  });
});

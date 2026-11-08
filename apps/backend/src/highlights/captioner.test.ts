import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Highlight, HighlightCaption } from '@sportlight/shared';
import { createLogger } from '../logger.js';
import {
  CAPTION_VERSION,
  CaptionError,
  GeminiCaptioner,
  HighlightCaptioner,
  TemplateCaptioner,
  momentFacts,
  parseCues,
  parseDraft,
  retryDelayMs,
} from './captioner.js';

const log = createLogger('test');

function highlight(patch: Partial<Highlight> = {}): Highlight {
  return {
    id: 'h1',
    day: '2026-11-07',
    feedId: 'fra-ger',
    runId: 'r1',
    sportId: 'football',
    event: {
      title: 'France v Germany',
      subtitle: 'Nations League · Stade de France',
      competitionId: 'uefa-nations-league',
      venue: 'Stade de France',
      broadcaster: { name: 'Sky Sports', channel: 'Sky Sports Football' },
    },
    source: { kind: 'looping-mp4', url: '/media/videos/f.mp4', durationSec: 120, mediaOffsetSec: 0, hasAudio: true },
    clip: { streamStart: 100, streamEnd: 120, mediaStart: 10, mediaEnd: 30, durationSec: 20 },
    peak: { score: 94, streamTime: 108, at: '2026-11-07T12:01:48Z' },
    startedAt: '2026-11-07T12:01:40Z',
    thumbnailUrl: '/media/thumbs/f/12.jpg',
    // Builds for 8 s from 55 to 94, then falls away.
    curve: [
      [0, 55],
      [4, 70],
      [8, 94],
      [10, 88],
      [14, 70],
      [20, 60],
    ],
    ...patch,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const video = { mimeType: 'video/mp4' as const, base64: 'AAAA' };
const loadMedia = async () => video;

describe('template captions', () => {
  it('describes the shape of the moment from the curve and metadata', () => {
    const f = momentFacts(highlight());
    expect(f).toMatchObject({ peak: 94, buildUpSec: 8, riseBy: 39, shape: 'surge', channel: 'Sky Sports Football' });
    const d = new TemplateCaptioner().draft(highlight());
    expect(d.title).toBe('Football · France v Germany');
    expect(d.description).toBe('A 20-second clip from France v Germany. Video description not yet available.');
  });

  it('recognises sudden spikes and sustained spells', () => {
    const spike = highlight({
      curve: [
        [0, 30],
        [6, 32],
        [8, 95],
        [9, 40],
      ],
      peak: { score: 95, streamTime: 108, at: '' },
    });
    expect(momentFacts(spike).shape).toBe('spike');
    const long = highlight({
      curve: Array.from({ length: 16 }, (_, i) => [i, 90] as [number, number]),
      peak: { score: 92, streamTime: 105, at: '' },
    });
    expect(momentFacts(long).shape).toBe('sustained');
  });
});

describe('parseDraft', () => {
  it('accepts fenced JSON, trims and limits fields', () => {
    const d = parseDraft(
      '```json\n{"title":"  Late  surge ","description":"A big moment.","tags":["#Football","Nations League","x","y","z"]}\n```',
    );
    expect(d).toEqual({
      title: 'Late surge',
      description: 'A big moment.',
      tags: ['football', 'nations league', 'x', 'y'],
    });
  });

  it('rejects empty captions', () => {
    expect(() => parseDraft('{"title":"","description":"x","tags":[]}')).toThrow();
  });
});

describe('GeminiCaptioner', () => {
  it('sends actual video with four frames per second and excludes intensity claims', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        candidates: [
          {
            content: {
              parts: [{ text: '{"title":"Les Bleus surge","description":"France pour forward.","tags":["football"]}' }],
            },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const model = new GeminiCaptioner('KEY', 'gemini-test');
    const draft = await model.caption(highlight(), video, new AbortController().signal);
    expect(draft.title).toBe('Les Bleus surge');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY');
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema.required).toEqual(['title', 'description', 'tags', 'commentary']);
    const parts = body.contents[0].parts;
    expect(parts[0].text).not.toContain('intensity');
    expect(parts[0].text).not.toContain('France v Germany');
    expect(parts[0].text).toContain('football');
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'video/mp4', data: 'AAAA' }, videoMetadata: { fps: 4 } });
  });
});

describe('HighlightCaptioner', () => {
  it('gives an instant template caption, then a versioned model caption from video', async () => {
    const fetchMock = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const got: Array<[string, HighlightCaption]> = [];
    const caption = vi.fn(async () => ({ title: 'Model title', description: 'Model description.', tags: [] }));
    const c = new HighlightCaptioner({
      model: { name: 'fake-model', caption },
      mediaFetchBase: 'http://media:8080',
      mediaPublicPrefix: '/media',
      onCaption: (id, cap) => got.push([id, cap]),
      log,
      minIntervalMs: 0,
      loadMedia,
    });

    const h = highlight();
    expect(c.instant(h).model).toBe('template');
    c.enqueue(h);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(caption.mock.calls[0]![1]).toEqual(video);
    expect(got[0]![1]).toMatchObject({ title: 'Model title', model: 'fake-model' });

    // Same moment again: not regenerated. A model caption survives a merge until rewritten.
    c.enqueue(h);
    expect(c.stats.pending).toBe(0);
    expect(c.instant(h, got[0]![1]).title).toBe('Model title');
    c.stop();
  });

  it('keeps the template caption when the model fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const onCaption = vi.fn();
    const c = new HighlightCaptioner({
      model: { name: 'm', caption: async () => Promise.reject(new Error('bad')) },
      mediaFetchBase: null,
      mediaPublicPrefix: '/media',
      onCaption,
      log,
      minIntervalMs: 0,
      loadMedia,
    });
    c.enqueue(highlight());
    await vi.waitFor(() => expect(c.stats.failed).toBe(1));
    expect(onCaption).not.toHaveBeenCalled();
    c.stop();
  });
});

describe('video caption lifecycle', () => {
  const draft = { title: 'A block in the box', description: 'A defender blocks the shot.', tags: ['football'] };
  function queue(caption = vi.fn(async () => draft), onCaption = vi.fn(), media = loadMedia) {
    return new HighlightCaptioner({
      model: { name: 'm', caption },
      onCaption,
      log,
      mediaFetchBase: null,
      mediaPublicPrefix: '/media',
      minIntervalMs: 0,
      loadMedia: media,
    });
  }

  it('never calls the model when video extraction fails', async () => {
    const caption = vi.fn(async () => draft);
    const c = queue(caption, vi.fn(), async () => {
      throw new Error('no video');
    });
    c.enqueue(highlight());
    await vi.waitFor(() => expect(c.stats.failed).toBe(1));
    expect(caption).not.toHaveBeenCalled();
    c.stop();
  });

  it('regenerates legacy captions and restores only matching pipeline, model and source', async () => {
    const onCaption = vi.fn();
    const c = queue(undefined, onCaption);
    const h = highlight({ caption: { ...draft, model: 'm', generatedAt: '' } });
    c.restore([h]);
    c.enqueue(h);
    await vi.waitFor(() => expect(onCaption).toHaveBeenCalledTimes(1));
    const saved = onCaption.mock.calls[0]![1] as HighlightCaption;
    expect(saved.version).toBe(CAPTION_VERSION);
    c.stop();
    const next = queue();
    next.restore([{ ...h, caption: saved }]);
    next.enqueue(h);
    expect(next.stats.pending).toBe(0);
    expect(next.stats.generated).toBe(0);
    const changed = { ...h, clip: { ...h.clip, mediaEnd: h.clip.mediaEnd + 1 } };
    next.enqueue(changed);
    await vi.waitFor(() => expect(next.stats.generated).toBe(1));
    next.stop();
    for (const patch of [{ model: 'old-model' }, { version: 'old-version' }]) {
      const c = queue();
      c.restore([{ ...h, caption: { ...saved, ...patch } }]);
      c.enqueue(h);
      await vi.waitFor(() => expect(c.stats.generated).toBe(1));
      c.stop();
    }
  });

  it('discards results for a forgotten highlight', async () => {
    let resolve!: (value: typeof draft) => void;
    const caption = vi.fn(
      () =>
        new Promise<typeof draft>((r) => {
          resolve = r;
        }),
    );
    const onCaption = vi.fn();
    const c = queue(caption, onCaption);
    c.enqueue(highlight());
    await vi.waitFor(() => expect(caption).toHaveBeenCalled());
    c.forget('h1');
    resolve(draft);
    await new Promise((r) => setTimeout(r, 10));
    expect(onCaption).not.toHaveBeenCalled();
    c.stop();
  });

  it('does not publish an obsolete result after the clip window changes', async () => {
    let resolve!: (value: typeof draft) => void;
    const caption = vi
      .fn(async () => draft)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
    const onCaption = vi.fn();
    const c = queue(caption, onCaption);
    const h = highlight();
    c.enqueue(h);
    await vi.waitFor(() => expect(caption).toHaveBeenCalledTimes(1));
    c.enqueue({ ...h, clip: { ...h.clip, mediaEnd: 31 } });
    resolve(draft);
    await vi.waitFor(() => expect(onCaption).toHaveBeenCalledTimes(1));
    expect(caption).toHaveBeenCalledTimes(2);
    expect(onCaption.mock.calls[0]![1].sourceSignature).toContain(',31,');
    c.stop();
  });

  it('bounds rate-limit retries to three instead of retrying indefinitely', async () => {
    vi.useFakeTimers();
    const caption = vi.fn(async () => {
      throw new CaptionError('rate limited', 429);
    });
    const c = queue(caption);
    c.enqueue(highlight());
    await vi.advanceTimersByTimeAsync(300_000);
    expect(caption).toHaveBeenCalledTimes(4);
    expect(c.stats.failed).toBe(1);
    expect(c.stats.pending).toBe(0);
    c.stop();
  });

  it('pauses the whole queue until the advised reset instead of burning retries', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const caption = vi.fn(async () => {
      if (++calls === 1) throw new CaptionError('daily quota', 429, 3_600_000);
      return draft;
    });
    const onCaption = vi.fn();
    const c = queue(caption, onCaption);
    c.enqueue(highlight());
    await vi.advanceTimersByTimeAsync(3_000_000);
    expect(caption).toHaveBeenCalledTimes(1);
    expect(c.stats.pending).toBe(1);
    expect(c.stats.failed).toBe(0);
    expect(c.stats.pausedUntil).not.toBeNull();
    await vi.advanceTimersByTimeAsync(700_000);
    expect(caption).toHaveBeenCalledTimes(2);
    expect(onCaption).toHaveBeenCalledTimes(1);
    expect(c.stats.pausedUntil).toBeNull();
    c.stop();
  });

  it('reads RetryInfo from a Gemini error body', () => {
    const body = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23003s' }] } });
    expect(retryDelayMs(body)).toBe(23_003_000);
    expect(retryDelayMs('not json')).toBeUndefined();
  });
});

describe('parseCues', () => {
  it('orders, clamps and de-overlaps commentary cues', () => {
    expect(
      parseCues(
        [
          { start: 5, end: 7, text: 'second' },
          { start: -1, end: 2.5, text: '  first   cue ' },
          { start: 6, end: 8, text: 'overlaps' },
          { start: 9, end: 30, text: 'runs past the end' },
          { start: 3, end: 3.1, text: 'too short' },
          { start: 'x', end: 4, text: 'bad' },
        ],
        12,
      ),
    ).toEqual([
      { start: 0, end: 2.5, text: 'first cue' },
      { start: 5, end: 7, text: 'second' },
      { start: 7, end: 8, text: 'overlaps' },
      { start: 9, end: 12, text: 'runs past the end' },
    ]);
    expect(parseCues('nope')).toEqual([]);
  });
  it('keeps cues returned with the caption', () => {
    const d = parseDraft(
      '{"title":"T","description":"D","tags":[],"commentary":[{"start":1,"end":2,"text":"Goal!"}]}',
      10,
    );
    expect(d.commentary).toEqual([{ start: 1, end: 2, text: 'Goal!' }]);
    expect(parseDraft('{"title":"T","description":"D","tags":[],"commentary":[]}').commentary).toBeUndefined();
  });
});

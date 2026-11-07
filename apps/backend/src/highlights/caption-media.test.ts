import { describe, expect, it } from 'vitest';
import { captionMediaUrl, extractCaptionVideo } from './caption-media.js';
import type { Highlight } from '@sportlight/shared';

const opts = { mediaFetchBase: 'http://media:8080', mediaPublicPrefix: '/media' };
describe('caption media', () => {
  it('resolves media prefixes for Docker and local development', () => {
    expect(captionMediaUrl('/media/videos/clip.mp4', opts)).toBe('http://media:8080/videos/clip.mp4');
    expect(captionMediaUrl('/media/videos/clip.mp4', { ...opts, mediaFetchBase: 'http://localhost:5173/media' })).toBe(
      'http://localhost:5173/media/videos/clip.mp4',
    );
    expect(captionMediaUrl('https://example.com/clip.mp4', opts)).toBe('https://example.com/clip.mp4');
  });
  it('rejects missing origins and non-HTTP media', () => {
    expect(() => captionMediaUrl('/media/x.mp4', { ...opts, mediaFetchBase: null })).toThrow('MEDIA_FETCH_BASE');
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'http://user:pass@example.com/x']) {
      expect(() => captionMediaUrl(url, opts)).toThrow();
    }
  });
  it('rejects invalid windows before invoking ffmpeg', async () => {
    for (const [mediaStart, mediaEnd] of [
      [-1, 20],
      [20, 10],
      [0, 121],
      [NaN, 20],
    ]) {
      await expect(
        extractCaptionVideo({ clip: { mediaStart, mediaEnd } } as Highlight, opts, new AbortController().signal),
      ).rejects.toThrow('window');
    }
  });
});

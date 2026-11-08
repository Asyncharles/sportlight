import { describe, expect, it } from 'vitest';
import type { Highlight } from '@sportlight/shared';
import { MediaSourceSchema } from '@sportlight/shared/schemas';
import { uploadMetadata } from './google.js';

describe('footage attribution', () => {
  it('survives source validation and reserves description space for credits and changes', () => {
    const source = MediaSourceSchema.parse({
      kind: 'looping-mp4',
      url: '/media/videos/open.mp4',
      durationSec: 90,
      mediaOffsetSec: 0,
      hasAudio: false,
      credits: [
        {
          title: 'Race footage',
          author: 'Original creator',
          license: 'CC BY 4.0',
          licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          sourceUrl: 'https://commons.wikimedia.org/wiki/File:Race.webm',
        },
      ],
      attributionNotice: 'Additional source notice.',
    });
    const h = {
      source,
      event: { title: 'A race' },
      sportId: 'cycling',
      caption: { title: 'Finish', description: 'Description '.repeat(1000) },
    } as Highlight;
    const metadata = uploadMetadata(h);
    expect(metadata.snippet.description.length).toBeLessThanOrEqual(5000);
    expect(metadata.snippet.description).toContain('Original creator');
    expect(metadata.snippet.description).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(metadata.snippet.description).toContain('https://commons.wikimedia.org/wiki/File:Race.webm');
    expect(metadata.snippet.description).toContain('Changes: excerpted, reframed and captioned');
    expect(metadata.snippet.description).toContain('Additional source notice.');
  });
});

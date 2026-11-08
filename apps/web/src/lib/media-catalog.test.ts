import { describe, expect, it } from 'vitest';
import { pickSportMedia } from './media-catalog';

const thumbs = (id: string, count: number) => ({ template: `thumbs/${id}/{index}.jpg`, intervalSec: 10, count });

describe('landing media from the catalog', () => {
  it('uses the files the media build really produced', () => {
    const media = pickSportMedia([
      { id: 'open-tennis-1', sportId: 'tennis', dataset: 'commons-open-v1', video: 'videos/open-tennis-1-ab12cd34ef.mp4', poster: 'posters/open-tennis-1.jpg', durationSec: 200, thumbnails: thumbs('open-tennis-1', 20) },
    ]);
    expect(media.get('tennis')).toEqual({
      video: '/media/videos/open-tennis-1-ab12cd34ef.mp4#t=30',
      poster: '/media/thumbs/open-tennis-1/3.jpg',
      startSec: 30,
    });
  });

  it('prefers the engine demo clip, then the longest open clip, and skips unusable entries', () => {
    const media = pickSportMedia([
      { id: 'short', sportId: 'football', dataset: 'commons-open-v1', video: 'videos/short.mp4', durationSec: 50 },
      { id: 'long', sportId: 'football', dataset: 'commons-open-v1', video: 'videos/long.mp4', durationSec: 220 },
      { id: 'fb-arg-fra', sportId: 'football', dataset: 'local-engine-v1', video: 'local/videos/fb_arg_fra_2022.mp4', durationSec: 4660, thumbnails: thumbs('fb-arg-fra', 466) },
      { id: 'cyc', sportId: 'cycling', dataset: 'commons-open-v1', video: 'videos/cyc.mp4', durationSec: 220 },
      { id: 'cyc-long', sportId: 'cycling', dataset: 'commons-open-v1', video: 'videos/cyc-long.mp4', durationSec: 500 },
      { id: 'legacy', video: 'videos/legacy.mp4', durationSec: 3000 },
      { id: 'fake', sportId: 'chess', synthetic: true, video: 'videos/fake.mp4', durationSec: 60 },
    ]);
    expect(media.get('football')?.video).toBe('/media/local/videos/fb_arg_fra_2022.mp4#t=60');
    expect(media.get('cycling')?.video).toMatch(/cyc-long/);
    expect(media.has('chess')).toBe(false);
    expect([...media.keys()].sort()).toEqual(['cycling', 'football']);
  });

  it('prefers modern clips over longer 1930s newsreel', () => {
    const media = pickSportMedia([
      { id: 'open-rugby-1936', sportId: 'rugby', dataset: 'commons-open-v1', video: 'videos/old.mp4', durationSec: 62, height: 576 },
      { id: 'open-rugby-66179715', sportId: 'rugby', dataset: 'commons-open-v1', video: 'videos/rwc2019.mp4', durationSec: 45, height: 480 },
      { id: 'open-tennis-a', sportId: 'tennis', dataset: 'commons-open-v1', video: 'videos/sd.mp4', durationSec: 200, height: 576 },
      { id: 'open-tennis-b', sportId: 'tennis', dataset: 'commons-open-v1', video: 'videos/hd.mp4', durationSec: 40, height: 1080 },
    ]);
    expect(media.get('rugby')?.video).toMatch(/rwc2019/);
    expect(media.get('tennis')?.video).toMatch(/hd\.mp4/);
  });

  it('starts short clips near the beginning and falls back to the poster', () => {
    const media = pickSportMedia([
      { id: 'c', sportId: 'chess', dataset: 'commons-open-v1', video: 'videos/c.mp4', poster: 'posters/c.jpg', durationSec: 20 },
    ]);
    expect(media.get('chess')).toEqual({ video: '/media/videos/c.mp4#t=4', poster: '/media/posters/c.jpg', startSec: 4 });
  });
});

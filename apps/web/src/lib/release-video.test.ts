import { describe, expect, it } from 'vitest';
import { releaseVideo } from './release-video';

describe('releaseVideo', () => {
  it('pauses, drops the src, then reloads so the browser aborts the download', () => {
    const calls: string[] = [];
    releaseVideo({
      pause: () => void calls.push('pause'),
      removeAttribute: (name: string) => void calls.push(`remove ${name}`),
      load: () => void calls.push('load'),
    });
    expect(calls).toEqual(['pause', 'remove src', 'load']);
  });
});

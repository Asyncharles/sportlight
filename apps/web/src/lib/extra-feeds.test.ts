import { describe, expect, it } from 'vitest';
import { countExtra, withoutExtra } from './extra-feeds';

const feed = (extra?: boolean, status = 'live') => ({ event: { title: 't', ...(extra ? { extra } : {}) }, status });

describe('extra feeds switch', () => {
  it('hides only feeds marked extra', () => {
    const feeds = { demo: feed(), tuning: feed(true), open: feed(true) };
    expect(Object.keys(withoutExtra(feeds))).toEqual(['demo']);
  });

  it('leaves a normal deployment (nothing marked extra) untouched', () => {
    const feeds = { a: feed(), b: feed() };
    expect(withoutExtra(feeds)).toBe(feeds);
  });

  it('counts extra feeds still on air', () => {
    expect(countExtra({ a: feed(true), b: feed(true, 'ended'), c: feed() })).toBe(1);
  });
});

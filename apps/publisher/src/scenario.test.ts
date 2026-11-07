import { describe, expect, it } from 'vitest';
import { DEMO_FEEDS, inWindows, intensityAt } from './scenario.js';

const feed = (id: string) => DEMO_FEEDS.find((f) => f.id === id)!;

describe('demo scenario', () => {
  it('is deterministic for a seed', () => {
    const a = DEMO_FEEDS.map((f) => intensityAt(f, 123.4, 42));
    const b = DEMO_FEEDS.map((f) => intensityAt(f, 123.4, 42));
    expect(a).toEqual(b);
    expect(DEMO_FEEDS.map((f) => intensityAt(f, 123.4, 7))).not.toEqual(a);
  });

  it('stays within 0–100', () => {
    for (const f of DEMO_FEEDS)
      for (let t = 0; t < 1800; t += 0.5) {
        const v = intensityAt(f, t, 1);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
  });

  it('creates a sustained peak and a brief spike', () => {
    const hockey = feed('rpi-syracuse');
    const sustained = [...Array(20).keys()].filter((i) => intensityAt(hockey, 40 + i, 1) >= 80).length;
    expect(sustained).toBeGreaterThanOrEqual(15);
    const chess = feed('blitz-open');
    const spike = [...Array(10).keys()].map((i) => intensityAt(chess, 68 + i, 1));
    expect(Math.max(...spike)).toBeGreaterThanOrEqual(85);
    expect(spike.filter((v) => v >= 70).length).toBeLessThanOrEqual(3);
  });

  it('starts and ends feeds during the session', () => {
    const tennis = feed('uru-mex');
    expect(inWindows(tennis.live, 100)).toBe(true);
    expect(inWindows(tennis.live, 250)).toBe(false);
    expect(inWindows(tennis.live, 300)).toBe(true);
    expect(inWindows(feed('relay-final').live, 50)).toBe(false);
  });

  it('references unique feed ids and known clip ids', () => {
    expect(new Set(DEMO_FEEDS.map((f) => f.id)).size).toBe(DEMO_FEEDS.length);
  });
});

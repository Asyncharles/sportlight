import { describe, expect, it } from 'vitest';
import { planLive } from './live-slots.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
const base = { lastEndedMs: new Map<string, number>(), now: 1_000_000, rotateMs: 300_000 };

describe('live slot cap', () => {
  it('starts at most `max` feeds', () => {
    const plan = planLive({ ...base, wanted: ids(30), running: new Map(), max: 10 });
    expect(plan.start).toEqual(ids(10));
    expect(plan.stop).toEqual([]);
  });

  it('is unlimited when max is 0', () => {
    expect(planLive({ ...base, wanted: ids(30), running: new Map(), max: 0 }).start).toHaveLength(30);
  });

  it('keeps feeds on air until they have had their turn', () => {
    const running = new Map(ids(10).map((id) => [id, base.now - 60_000]));
    const plan = planLive({ ...base, wanted: ids(30), running, max: 10 });
    expect(plan).toEqual({ start: [], stop: [] });
  });

  it('rotates the longest-running feeds out for waiting ones, least recently aired first', () => {
    const running = new Map(ids(10).map((id, i) => [id, base.now - (i < 2 ? 400_000 : 60_000)]));
    const lastEndedMs = new Map([['f10', base.now - 1000]]);
    const plan = planLive({ ...base, lastEndedMs, wanted: ids(13), running, max: 10 });
    expect(plan.stop).toEqual(['f0', 'f1']);
    expect(plan.start).toEqual(['f11', 'f12']);
  });

  it('ends feeds that are no longer scheduled and fills their slots', () => {
    const running = new Map(ids(10).map((id) => [id, base.now]));
    const plan = planLive({ ...base, wanted: [...ids(9), 'x'], running, max: 10 });
    expect(plan).toEqual({ stop: ['f9'], start: ['x'] });
  });

  it('trims to the cap when the limit is lowered', () => {
    const running = new Map(ids(12).map((id, i) => [id, base.now - i]));
    const plan = planLive({ ...base, wanted: ids(12), running, max: 10 });
    expect(plan.stop).toEqual(['f11', 'f10']);
  });
});

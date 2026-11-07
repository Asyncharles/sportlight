import { useSyncExternalStore } from 'react';
import type { FeedId, FeedState, RunId } from '@sportlight/shared';
import { apiUrl } from './env';
import { live } from './live-client';

/**
 * Recent intensity per feed, for trend lines. Built from the live updates the client already
 * receives, and seeded from the backend's history after every (re)connection so lines are full
 * straight away.
 */

export type TrailPoint = [streamTime: number, score: number];

interface Trail {
  runId: RunId;
  points: TrailPoint[];
}

const KEEP_SEC = 180;
const trails = new Map<FeedId, Trail>();
const listeners = new Set<() => void>();
let lastFeeds: Readonly<Record<FeedId, FeedState>> | null = null;
let lastEpoch = 0;
let started = false;

function emit() {
  for (const l of listeners) l();
}

function append(feed: FeedState) {
  const r = feed.intensity;
  if (!r) return false;
  const t = trails.get(feed.id);
  if (!t || t.runId !== feed.runId) {
    trails.set(feed.id, { runId: feed.runId, points: [[r.streamTime, r.score]] });
    return true;
  }
  const last = t.points[t.points.length - 1];
  if (last && r.streamTime <= last[0]) return false;
  const points = [...t.points, [r.streamTime, r.score] as TrailPoint].filter(([s]) => s >= r.streamTime - KEEP_SEC);
  trails.set(feed.id, { runId: t.runId, points });
  return true;
}

async function seed() {
  try {
    const res = await fetch(apiUrl(`/api/feeds/recent?sec=${KEEP_SEC}`));
    if (!res.ok) return;
    const body = (await res.json()) as { feeds: Record<FeedId, { runId: RunId; points: TrailPoint[] }> };
    let changed = false;
    for (const [id, { runId, points }] of Object.entries(body.feeds)) {
      if (points.length < 2) continue;
      const t = trails.get(id);
      if (t && t.runId === runId && t.points.length >= points.length) continue;
      const newer = t && t.runId === runId ? t.points.filter(([s]) => s > points[points.length - 1]![0]) : [];
      trails.set(id, { runId, points: [...points, ...newer] });
      changed = true;
    }
    if (changed) emit();
  } catch {
    /* trend lines simply build up from live updates */
  }
}

function start() {
  if (started) return;
  started = true;
  live.store.subscribe(() => {
    const s = live.store.get();
    if (s.epoch !== lastEpoch) {
      lastEpoch = s.epoch;
      void seed();
    }
    if (s.feeds === lastFeeds) return;
    lastFeeds = s.feeds;
    let changed = false;
    for (const f of Object.values(s.feeds)) changed = append(f) || changed;
    for (const id of trails.keys()) if (!s.feeds[id]) (trails.delete(id), (changed = true));
    if (changed) emit();
  });
}

const subscribe = (cb: () => void) => {
  start();
  listeners.add(cb);
  return () => listeners.delete(cb);
};

const EMPTY: TrailPoint[] = [];

/** The last `seconds` of a feed's intensity. Stable reference between updates. */
export function useIntensityTrail(feedId: FeedId, runId: RunId): TrailPoint[] {
  return useSyncExternalStore(subscribe, () => {
    const t = trails.get(feedId);
    return t && t.runId === runId ? t.points : EMPTY;
  });
}

/** Points within the last `seconds` of a trail. */
export function windowed(points: TrailPoint[], seconds: number): TrailPoint[] {
  if (points.length === 0) return points;
  const end = points[points.length - 1]![0];
  const i = points.findIndex(([t]) => t >= end - seconds);
  return i <= 0 ? points : points.slice(i);
}

/** Change in score over the last `seconds` (null when there isn't enough history). */
export function trendOf(points: TrailPoint[], seconds: number): number | null {
  const w = windowed(points, seconds);
  if (w.length < 2) return null;
  return w[w.length - 1]![1] - w[0]![1];
}

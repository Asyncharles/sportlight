import type { AnyFeedEvent, FeedId, FeedState, IntensityReading, RunId } from '@sportlight/shared';

/**
 * Authoritative feed state.
 *
 * Applies provider events with strict ordering so duplicate, delayed or out-of-order deliveries
 * never restore outdated state (see the ordering model in `@sportlight/shared/events`). Late
 * intensity readings are still surfaced (`late-intensity`) so history can be back-filled without
 * moving the live state backwards.
 */

export type DropReason = 'duplicate' | 'stale-seq' | 'stale-run' | 'unknown-feed' | 'unknown-run' | 'after-end';

export type ApplyOutcome =
  | {
      kind: 'applied';
      feed: FeedState;
      reading?: IntensityReading;
      started?: boolean;
      ended?: boolean;
      /** Set when a new run replaced an older one that never sent `feed.ended`. */
      replacedRunId?: RunId;
    }
  | { kind: 'late-intensity'; feedId: FeedId; runId: RunId; reading: IntensityReading }
  | { kind: 'dropped'; reason: DropReason };

export interface FeedStats {
  applied: number;
  dropped: Partial<Record<DropReason, number>>;
  lateIntensity: number;
  /** Delivery lag (backend receive time − provider occurredAt) of the most recent event, ms. */
  lastLagMs: number | null;
  /** Exponentially weighted delivery lag, ms. */
  avgLagMs: number | null;
}

export interface FeedRecord {
  state: FeedState;
  runStartedAtMs: number;
  firstSeenAt: number;
  lastEventReceivedAt: number;
  lastIntensityReceivedAt: number | null;
  providerUnavailable: boolean;
  silent: boolean;
  endedAtMs: number | null;
  stats: FeedStats;
}

export interface StoreTiming {
  staleAfterMs: number;
  silentAfterMs: number;
  expireAfterMs: number;
  endedRetentionMs: number;
}

export interface TickResult {
  changed: FeedState[];
  removed: FeedId[];
  /** Feeds that ended during this tick (timeout), for downstream cleanup. */
  ended: FeedState[];
}

class BoundedSet<T> {
  private readonly items = new Set<T>();
  constructor(private readonly capacity: number) {}
  has(v: T) {
    return this.items.has(v);
  }
  add(v: T) {
    this.items.add(v);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
    }
  }
}

const EWMA_ALPHA = 0.2;

export class FeedStore {
  private readonly records = new Map<FeedId, FeedRecord>();
  private readonly seenEventIds = new BoundedSet<string>(50_000);
  readonly totals = { applied: 0, lateIntensity: 0, dropped: {} as Partial<Record<DropReason, number>> };

  constructor(private readonly timing: StoreTiming) {}

  apply(event: AnyFeedEvent, receivedAt: number): ApplyOutcome {
    if (this.seenEventIds.has(event.eventId)) return this.drop(this.records.get(event.feedId), 'duplicate');
    this.seenEventIds.add(event.eventId);

    const runStartedAtMs = Date.parse(event.runStartedAt);
    let record = this.records.get(event.feedId);
    let replacedRunId: RunId | undefined;

    // Run ordering: a newer run supersedes; an older run is outdated.
    if (record && record.state.runId !== event.runId) {
      if (runStartedAtMs < record.runStartedAtMs) return this.drop(record, 'stale-run');
      if (event.type !== 'feed.started') return this.drop(record, 'unknown-run');
      if (record.state.status !== 'ended') replacedRunId = record.state.runId;
      record = undefined; // new run replaces the record below
    }

    if (!record) {
      if (event.type !== 'feed.started') return this.drop(undefined, 'unknown-feed');
      const prevStats = this.records.get(event.feedId)?.stats;
      record = {
        state: {
          id: event.feedId,
          runId: event.runId,
          provider: event.provider,
          sportId: event.payload.sportId,
          event: event.payload.event,
          source: event.payload.source,
          status: 'live',
          startedAt: new Date(runStartedAtMs).toISOString(),
          intensity: null,
          intensityStale: true,
          seq: event.seq,
          votes: { up: 0, down: 0 },
        },
        runStartedAtMs,
        firstSeenAt: receivedAt,
        lastEventReceivedAt: receivedAt,
        lastIntensityReceivedAt: null,
        providerUnavailable: false,
        silent: false,
        endedAtMs: null,
        stats: prevStats ?? { applied: 0, dropped: {}, lateIntensity: 0, lastLagMs: null, avgLagMs: null },
      };
      this.records.set(event.feedId, record);
      this.noteApplied(record, event, receivedAt);
      return { kind: 'applied', feed: record.state, started: true, ...(replacedRunId ? { replacedRunId } : {}) };
    }

    // Same run from here on.
    if (record.state.status === 'ended') return this.drop(record, 'after-end');
    if (event.seq <= record.state.seq) {
      if (event.type === 'feed.intensity') {
        record.stats.lateIntensity++;
        this.totals.lateIntensity++;
        return {
          kind: 'late-intensity',
          feedId: event.feedId,
          runId: event.runId,
          reading: { score: event.payload.score, streamTime: event.payload.streamTime, at: event.occurredAt },
        };
      }
      return this.drop(record, 'stale-seq');
    }

    const s = record.state;
    s.seq = event.seq;
    record.lastEventReceivedAt = receivedAt;
    record.silent = false;
    let reading: IntensityReading | undefined;
    let ended = false;

    switch (event.type) {
      case 'feed.started': // re-announcement of the current run: refresh metadata
        s.sportId = event.payload.sportId;
        s.event = event.payload.event;
        s.source = event.payload.source;
        break;
      case 'feed.intensity':
        reading = { score: event.payload.score, streamTime: event.payload.streamTime, at: event.occurredAt };
        s.intensity = reading;
        s.intensityStale = false;
        record.lastIntensityReceivedAt = receivedAt;
        break;
      case 'feed.updated':
        if (event.payload.sportId) s.sportId = event.payload.sportId;
        if (event.payload.event) s.event = event.payload.event;
        if (event.payload.source) s.source = event.payload.source;
        if (event.payload.availability) record.providerUnavailable = event.payload.availability === 'unavailable';
        break;
      case 'feed.ended':
        record.endedAtMs = receivedAt;
        s.endedAt = event.occurredAt;
        s.endReason = event.payload.reason;
        ended = true;
        break;
    }
    this.deriveStatus(record);
    this.noteApplied(record, event, receivedAt);
    return { kind: 'applied', feed: s, ...(reading ? { reading } : {}), ...(ended ? { ended } : {}) };
  }

  /** Time-based transitions: stale intensity, silent feeds, expiry and removal of ended feeds. */
  tick(now: number): TickResult {
    const result: TickResult = { changed: [], removed: [], ended: [] };
    for (const [id, r] of this.records) {
      const s = r.state;
      if (s.status === 'ended') {
        if (r.endedAtMs !== null && now - r.endedAtMs >= this.timing.endedRetentionMs) {
          this.records.delete(id);
          result.removed.push(id);
        }
        continue;
      }
      const before = `${s.status}|${s.intensityStale}|${s.unavailableReason ?? ''}`;
      const sinceEvent = now - r.lastEventReceivedAt;
      s.intensityStale =
        r.lastIntensityReceivedAt === null || now - r.lastIntensityReceivedAt > this.timing.staleAfterMs;
      r.silent = sinceEvent > this.timing.silentAfterMs;
      if (sinceEvent > this.timing.expireAfterMs) {
        r.endedAtMs = now;
        s.endedAt = new Date(now).toISOString();
        s.endReason = 'timeout';
        result.ended.push(s);
      }
      this.deriveStatus(r);
      if (`${s.status}|${s.intensityStale}|${s.unavailableReason ?? ''}` !== before) result.changed.push(s);
    }
    return result;
  }

  setVotes(feedId: FeedId, runId: RunId, votes: { up: number; down: number }): FeedState | undefined {
    const r = this.records.get(feedId);
    if (!r || r.state.runId !== runId) return undefined;
    r.state.votes = votes;
    return r.state;
  }

  get(feedId: FeedId): FeedState | undefined {
    return this.records.get(feedId)?.state;
  }

  snapshot(): FeedState[] {
    return [...this.records.values()].map((r) => r.state);
  }

  recordsView(): ReadonlyMap<FeedId, Readonly<FeedRecord>> {
    return this.records;
  }

  private deriveStatus(r: FeedRecord) {
    const s = r.state;
    if (r.endedAtMs !== null) {
      s.status = 'ended';
      delete s.unavailableReason;
    } else if (r.providerUnavailable || r.silent) {
      s.status = 'unavailable';
      s.unavailableReason = r.providerUnavailable ? 'provider' : 'silent';
    } else {
      s.status = 'live';
      delete s.unavailableReason;
    }
  }

  private noteApplied(r: FeedRecord, event: AnyFeedEvent, receivedAt: number) {
    r.stats.applied++;
    this.totals.applied++;
    const lag = Math.max(0, receivedAt - Date.parse(event.occurredAt));
    r.stats.lastLagMs = lag;
    r.stats.avgLagMs = r.stats.avgLagMs === null ? lag : r.stats.avgLagMs + EWMA_ALPHA * (lag - r.stats.avgLagMs);
  }

  private drop(r: FeedRecord | undefined, reason: DropReason): ApplyOutcome {
    this.totals.dropped[reason] = (this.totals.dropped[reason] ?? 0) + 1;
    if (r) r.stats.dropped[reason] = (r.stats.dropped[reason] ?? 0) + 1;
    return { kind: 'dropped', reason };
  }
}

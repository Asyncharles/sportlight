import type { FeedId, Follow, RunId, ViewerTile, VoteValue } from '@sportlight/shared';

export interface ViewerSession {
  sessionId: string;
  viewerId: string | null;
  client: string | null;
  connectedAt: number;
  follows: Follow[];
  tiles: ViewerTile[];
  lastStateAt: number | null;
}

/**
 * Per-viewer state. Each viewer's display selection is computed on their own device from their
 * own preferences; the backend only records what they report (for operations visibility) and
 * their votes. Votes are keyed by the persistent viewerId so they survive reconnects, and by run
 * so they reset when a feed restarts.
 */
export class ViewerRegistry {
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly votes = new Map<string, Map<string, VoteValue>>();

  connect(sessionId: string, now = Date.now()): ViewerSession {
    const s: ViewerSession = {
      sessionId,
      viewerId: null,
      client: null,
      connectedAt: now,
      follows: [],
      tiles: [],
      lastStateAt: null,
    };
    this.sessions.set(sessionId, s);
    return s;
  }

  hello(sessionId: string, viewerId: string, client: string | undefined) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.viewerId = viewerId;
    s.client = client ?? null;
  }

  updateState(sessionId: string, follows: Follow[], tiles: ViewerTile[], now = Date.now()) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.follows = follows;
    s.tiles = tiles;
    s.lastStateAt = now;
  }

  disconnect(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  /** Record a vote and return the run's new tally. */
  vote(viewerId: string, feedId: FeedId, runId: RunId, value: VoteValue): { up: number; down: number } {
    const key = `${feedId}|${runId}`;
    let m = this.votes.get(key);
    if (!m) {
      m = new Map();
      this.votes.set(key, m);
    }
    if (value === 0) m.delete(viewerId);
    else m.set(viewerId, value);
    return this.tally(feedId, runId);
  }

  tally(feedId: FeedId, runId: RunId): { up: number; down: number } {
    let up = 0;
    let down = 0;
    for (const v of this.votes.get(`${feedId}|${runId}`)?.values() ?? []) {
      if (v > 0) up++;
      else if (v < 0) down++;
    }
    return { up, down };
  }

  clearRun(feedId: FeedId, runId: RunId) {
    this.votes.delete(`${feedId}|${runId}`);
  }

  list(): ViewerSession[] {
    return [...this.sessions.values()];
  }

  get size() {
    return this.sessions.size;
  }

  /** How many sessions currently display a feed, and how far behind live they are on average. */
  watching(feedId: FeedId): { viewers: number; mainViewers: number; avgLagSec: number | null } {
    let viewers = 0;
    let mainViewers = 0;
    let lagSum = 0;
    for (const s of this.sessions.values()) {
      const tile = s.tiles.find((t) => t.feedId === feedId);
      if (!tile) continue;
      viewers++;
      if (tile.slot === 'main') mainViewers++;
      lagSum += tile.lagSec;
    }
    return { viewers, mainViewers, avgLagSec: viewers ? lagSum / viewers : null };
  }
}

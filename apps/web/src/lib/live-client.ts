import {
  WS_PATH,
  WS_PROTOCOL_VERSION,
  type ClientConfig,
  type ClientMessage,
  type FeedId,
  type FeedState,
  type Highlight,
  type ServerMessage,
} from '@sportlight/shared';
import { wsUrl } from './env';
import { Store, storage, useStore } from './store';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

export interface LiveState {
  status: ConnectionStatus;
  /** True once the first snapshot has arrived (distinguishes "loading" from "nothing live"). */
  ready: boolean;
  feeds: Readonly<Record<FeedId, FeedState>>;
  config: ClientConfig | null;
  /** serverTime − clientTime, ms. Add to Date.now() for server-aligned time. */
  clockOffsetMs: number;
  lastMessageAt: number | null;
  /** Increments on every (re)connection snapshot; consumers refetch REST data on change. */
  epoch: number;
}

type HighlightEvent = { type: 'upsert'; highlight: Highlight } | { type: 'remove'; id: string };

const PING_MS = 10_000;
const DEAD_AFTER_MS = 25_000;

function viewerId(): string {
  const key = 'sportlight.viewer';
  let id = storage.read<string | null>(key, null);
  if (!id) {
    id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    storage.write(key, id);
  }
  return id;
}

/**
 * Single WebSocket connection to the backend.
 *  - Reconnects with jittered exponential backoff, immediately on `online`/tab focus.
 *  - Every connection begins with a full snapshot, which replaces local state (restore after
 *    reconnect).
 *  - Estimates the server clock offset from ping/pong round-trips (min-RTT sample) so every viewer
 *    computes the same live media position.
 */
class LiveClient {
  readonly store = new Store<LiveState>({
    status: 'connecting',
    ready: false,
    feeds: {},
    config: null,
    clockOffsetMs: 0,
    lastMessageAt: null,
    epoch: 0,
  });
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private pingTimer: number | undefined;
  private started = false;
  private bestRtt = Infinity;
  private readonly highlightListeners = new Set<(e: HighlightEvent) => void>();
  private lastViewerState: string | null = null;

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener('online', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
    this.connect();
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Report what this viewer is showing; deduplicated, re-sent after reconnects. */
  reportViewerState(msg: Extract<ClientMessage, { type: 'viewer.state' }>) {
    const json = JSON.stringify(msg);
    if (json === this.lastViewerState) return;
    this.lastViewerState = json;
    this.send(msg);
  }

  onHighlight(listener: (e: HighlightEvent) => void) {
    this.highlightListeners.add(listener);
    return () => {
      this.highlightListeners.delete(listener);
    };
  }

  serverNow() {
    return Date.now() + this.store.get().clockOffsetMs;
  }

  private connect() {
    clearTimeout(this.retryTimer);
    const ws = new WebSocket(wsUrl(WS_PATH));
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.send({
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        viewerId: viewerId(),
        client: navigator.userAgent.slice(0, 160),
      });
      if (this.lastViewerState) this.ws?.send(this.lastViewerState);
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (e) => this.onMessage(e.data as string);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.store.set((s) => ({ ...s, status: 'reconnecting' }));
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private reconnectNow() {
    const s = this.ws?.readyState;
    if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
    this.attempt = 0;
    this.connect();
  }

  private ping() {
    const last = this.store.get().lastMessageAt;
    if (last && Date.now() - last > DEAD_AFTER_MS) {
      // Half-open connection: force a reconnect.
      this.ws?.close();
      return;
    }
    this.send({ type: 'ping', clientTime: Date.now() });
  }

  private onMessage(raw: string) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    const now = Date.now();
    switch (msg.type) {
      case 'welcome':
        this.bestRtt = Infinity;
        this.store.set((s) => ({ ...s, config: msg.config, clockOffsetMs: msg.serverTime - now, lastMessageAt: now }));
        return;
      case 'snapshot':
        this.store.set((s) => ({
          ...s,
          status: 'open',
          ready: true,
          feeds: Object.fromEntries(msg.feeds.map((f) => [f.id, f])),
          lastMessageAt: now,
          epoch: s.epoch + 1,
        }));
        return;
      case 'feeds':
        this.store.set((s) => {
          const feeds = { ...s.feeds };
          for (const f of msg.feeds) {
            const prev = feeds[f.id];
            // Never step back within a run (defensive; the server already orders events).
            if (prev && prev.runId === f.runId && f.seq < prev.seq) continue;
            feeds[f.id] = f;
          }
          return { ...s, feeds, lastMessageAt: now };
        });
        return;
      case 'feed.removed':
        this.store.set((s) => {
          const { [msg.feedId]: _removed, ...feeds } = s.feeds;
          return { ...s, feeds, lastMessageAt: now };
        });
        return;
      case 'highlight':
        this.touch(now);
        for (const l of this.highlightListeners) l({ type: 'upsert', highlight: msg.highlight });
        return;
      case 'highlight.removed':
        this.touch(now);
        for (const l of this.highlightListeners) l({ type: 'remove', id: msg.id });
        return;
      case 'pong': {
        const rtt = now - msg.clientTime;
        this.touch(now);
        if (rtt <= this.bestRtt) {
          this.bestRtt = rtt;
          const offset = msg.serverTime + rtt / 2 - now;
          this.store.set((s) => ({ ...s, clockOffsetMs: offset }));
        }
        return;
      }
      case 'error':
        console.warn('[live]', msg.code, msg.message);
        return;
    }
  }

  private touch(now: number) {
    this.store.set((s) => ({ ...s, lastMessageAt: now }));
  }
}

export const live = new LiveClient();

export function useLive(): LiveState {
  return useStore(live.store);
}

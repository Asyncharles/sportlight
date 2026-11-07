import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  WS_PATH,
  WS_PROTOCOL_VERSION,
  type ClientConfig,
  type ClientMessage,
  type FeedState,
  type ServerMessage,
} from '@sportlight/shared';
import { ClientMessageSchema } from '@sportlight/shared/schemas';
import type { Logger } from './logger.js';

interface Client {
  ws: WebSocket;
  sessionId: string;
  alive: boolean;
  /** Set when a batch was skipped under backpressure; the client gets a fresh snapshot instead. */
  needsSnapshot: boolean;
  msgWindowStart: number;
  msgCount: number;
}

export interface HubOptions {
  server: Server;
  config: ClientConfig;
  broadcastIntervalMs: number;
  snapshot: () => FeedState[];
  onConnect: (sessionId: string, req: IncomingMessage) => void;
  onMessage: (sessionId: string, msg: ClientMessage) => void;
  onDisconnect: (sessionId: string) => void;
  log: Logger;
}

const MAX_BUFFERED_BYTES = 1_000_000;
const MAX_MESSAGES_PER_SEC = 30;
const HEARTBEAT_MS = 20_000;

/**
 * WebSocket fan-out. Feed changes are coalesced and flushed as one `feeds` batch per interval;
 * every connection starts with `welcome` + `snapshot`, which is also how reconnecting clients
 * restore state.
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, Client>();
  private readonly pending = new Map<string, FeedState>();
  private readonly flushTimer: NodeJS.Timeout;
  private readonly heartbeatTimer: NodeJS.Timeout;

  constructor(private readonly opts: HubOptions) {
    this.wss = new WebSocketServer({ server: opts.server, path: WS_PATH, maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    this.flushTimer = setInterval(() => this.flush(), opts.broadcastIntervalMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
  }

  get size() {
    return this.clients.size;
  }

  /** Queue a feed for the next batched broadcast (latest state wins). */
  queueFeed(feed: FeedState) {
    this.pending.set(feed.id, feed);
  }

  broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) this.send(c, data);
  }

  sendTo(sessionId: string, msg: ServerMessage) {
    const c = this.clients.get(sessionId);
    if (c) this.send(c, JSON.stringify(msg));
  }

  async close() {
    clearInterval(this.flushTimer);
    clearInterval(this.heartbeatTimer);
    for (const c of this.clients.values()) c.ws.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const sessionId = randomUUID();
    const client: Client = {
      ws,
      sessionId,
      alive: true,
      needsSnapshot: false,
      msgWindowStart: Date.now(),
      msgCount: 0,
    };
    this.clients.set(sessionId, client);
    this.opts.onConnect(sessionId, req);

    ws.on('pong', () => (client.alive = true));
    ws.on('message', (raw) => this.onRawMessage(client, raw.toString()));
    ws.on('close', () => {
      this.clients.delete(sessionId);
      this.opts.onDisconnect(sessionId);
    });
    ws.on('error', (err) => this.opts.log.debug('ws error', { err, sessionId }));

    this.send(
      client,
      JSON.stringify({
        type: 'welcome',
        protocolVersion: WS_PROTOCOL_VERSION,
        sessionId,
        serverTime: Date.now(),
        config: this.opts.config,
      } satisfies ServerMessage),
    );
    this.sendSnapshot(client);
  }

  private onRawMessage(client: Client, raw: string) {
    const now = Date.now();
    if (now - client.msgWindowStart > 1_000) {
      client.msgWindowStart = now;
      client.msgCount = 0;
    }
    if (++client.msgCount > MAX_MESSAGES_PER_SEC) {
      client.ws.close(1008, 'rate limit exceeded');
      return;
    }
    let msg: ClientMessage;
    try {
      const parsed = ClientMessageSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid message');
      msg = parsed.data;
    } catch (err) {
      this.send(
        client,
        JSON.stringify({ type: 'error', code: 'bad_message', message: (err as Error).message } satisfies ServerMessage),
      );
      return;
    }
    if (msg.type === 'ping') {
      this.send(
        client,
        JSON.stringify({ type: 'pong', clientTime: msg.clientTime, serverTime: Date.now() } satisfies ServerMessage),
      );
      return;
    }
    if (msg.type === 'hello' && msg.protocolVersion !== WS_PROTOCOL_VERSION) {
      this.send(
        client,
        JSON.stringify({
          type: 'error',
          code: 'protocol_mismatch',
          message: `Server speaks protocol ${WS_PROTOCOL_VERSION}`,
        } satisfies ServerMessage),
      );
    }
    this.opts.onMessage(client.sessionId, msg);
  }

  private flush() {
    if (this.pending.size === 0 && ![...this.clients.values()].some((c) => c.needsSnapshot)) return;
    const feeds = [...this.pending.values()];
    this.pending.clear();
    const data = feeds.length
      ? JSON.stringify({ type: 'feeds', serverTime: Date.now(), feeds } satisfies ServerMessage)
      : null;
    for (const c of this.clients.values()) {
      if (c.needsSnapshot) {
        if (c.ws.bufferedAmount < MAX_BUFFERED_BYTES / 4) this.sendSnapshot(c);
        continue;
      }
      if (data) this.send(c, data);
    }
  }

  private sendSnapshot(c: Client) {
    c.needsSnapshot = false;
    this.send(
      c,
      JSON.stringify({ type: 'snapshot', serverTime: Date.now(), feeds: this.opts.snapshot() } satisfies ServerMessage),
    );
  }

  private send(c: Client, data: string) {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      c.needsSnapshot = true; // slow consumer: skip, resync with a snapshot when it drains
      return;
    }
    c.ws.send(data);
  }

  private heartbeat() {
    for (const c of this.clients.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }
}

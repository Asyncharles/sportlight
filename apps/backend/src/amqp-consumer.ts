import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { AMQP_TOPOLOGY, type AnyFeedEvent } from '@sportlight/shared';
import { FeedEventSchema } from '@sportlight/shared/schemas';
import type { Logger } from './logger.js';

export interface ConsumerStats {
  connected: boolean;
  queue: string;
  connectedSince: number | null;
  reconnects: number;
  received: number;
  invalid: number;
  /** Messages per second, exponentially smoothed. */
  ratePerSec: number;
  queueDepth: number | null;
  lastMessageAt: number | null;
  lastError: string | null;
}

export interface ConsumerOptions {
  url: string;
  queue: string;
  prefetch: number;
  onEvent: (event: AnyFeedEvent, receivedAt: number) => void;
  log: Logger;
}

/**
 * Consumes provider events from RabbitMQ with automatic reconnection.
 *
 * Messages are validated against the shared schema; malformed ones are rejected without requeue and
 * land in the dead-letter queue for inspection. Valid messages are acked after being applied.
 */
export class FeedEventConsumer {
  readonly stats: ConsumerStats;
  private conn: ChannelModel | null = null;
  private channel: Channel | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private windowCount = 0;

  constructor(private readonly opts: ConsumerOptions) {
    this.stats = {
      connected: false,
      queue: opts.queue,
      connectedSince: null,
      reconnects: 0,
      received: 0,
      invalid: 0,
      ratePerSec: 0,
      queueDepth: null,
      lastMessageAt: null,
      lastError: null,
    };
  }

  start() {
    this.metricsTimer = setInterval(() => void this.sampleMetrics(), 1_000);
    void this.connect(0);
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    try {
      await this.channel?.close();
      await this.conn?.close();
    } catch {
      /* already closed */
    }
  }

  private async connect(attempt: number) {
    if (this.stopped) return;
    const { log } = this.opts;
    try {
      const conn = await amqp.connect(this.opts.url, { clientProperties: { connection_name: 'sportlight-backend' } });
      conn.on('error', (err) => log.warn('amqp connection error', { err }));
      conn.on('close', () => this.onClose());
      const ch = await conn.createChannel();
      await this.declareTopology(ch);
      await ch.prefetch(this.opts.prefetch);
      await ch.consume(this.opts.queue, (msg) => this.handle(ch, msg), { noAck: false });
      this.conn = conn;
      this.channel = ch;
      this.stats.connected = true;
      this.stats.connectedSince = Date.now();
      this.stats.lastError = null;
      log.info('consuming feed events', { queue: this.opts.queue });
    } catch (err) {
      this.stats.lastError = describeError(err);
      const delay = Math.min(30_000, 500 * 2 ** attempt);
      log.warn('amqp connect failed, retrying', { err: this.stats.lastError, inMs: delay });
      this.retryTimer = setTimeout(() => void this.connect(attempt + 1), delay);
    }
  }

  private async declareTopology(ch: Channel) {
    const t = AMQP_TOPOLOGY;
    await ch.assertExchange(t.exchange, t.exchangeType, { durable: true });
    await ch.assertExchange(t.deadLetterExchange, 'fanout', { durable: true });
    await ch.assertQueue(t.deadLetterQueue, { durable: true, arguments: { 'x-message-ttl': 86_400_000 } });
    await ch.bindQueue(t.deadLetterQueue, t.deadLetterExchange, '');
    await ch.assertQueue(this.opts.queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': t.deadLetterExchange,
        // Intensity is only useful while fresh; cap the backlog after an outage.
        'x-max-length': 100_000,
      },
    });
    await ch.bindQueue(this.opts.queue, t.exchange, t.bindingKey);
  }

  private handle(ch: Channel, msg: ConsumeMessage | null) {
    if (!msg) return; // consumer cancelled by broker; the close handler reconnects
    const receivedAt = Date.now();
    this.stats.received++;
    this.windowCount++;
    this.stats.lastMessageAt = receivedAt;
    let event: AnyFeedEvent;
    try {
      const parsed = FeedEventSchema.safeParse(JSON.parse(msg.content.toString('utf8')));
      if (!parsed.success)
        throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      event = parsed.data;
    } catch (err) {
      this.stats.invalid++;
      this.opts.log.warn('rejecting invalid feed event', { err, routingKey: msg.fields.routingKey });
      ch.nack(msg, false, false);
      return;
    }
    try {
      this.opts.onEvent(event, receivedAt);
      ch.ack(msg);
    } catch (err) {
      // A processing bug must not poison the queue: dead-letter and carry on.
      this.opts.log.error('failed to apply feed event', { err, eventId: event.eventId });
      ch.nack(msg, false, false);
    }
  }

  private onClose() {
    if (!this.stats.connected && !this.conn) return;
    this.stats.connected = false;
    this.stats.connectedSince = null;
    this.conn = null;
    this.channel = null;
    if (this.stopped) return;
    this.stats.reconnects++;
    this.opts.log.warn('amqp connection closed, reconnecting');
    void this.connect(0);
  }

  private async sampleMetrics() {
    // 1 s window, smoothed over ~5 s.
    this.stats.ratePerSec += 0.2 * (this.windowCount - this.stats.ratePerSec);
    this.windowCount = 0;
    if (!this.channel) return;
    try {
      const q = await this.channel.checkQueue(this.opts.queue);
      this.stats.queueDepth = q.messageCount;
    } catch {
      /* channel closing */
    }
  }
}

/** Node reports a refused dual-stack connect as an AggregateError with an empty message. */
export function describeError(err: unknown): string {
  const e = err as Error & { code?: string; errors?: Array<Error & { code?: string }> };
  return e.message || e.code || e.errors?.map((x) => x.code ?? x.message).join(', ') || String(err);
}

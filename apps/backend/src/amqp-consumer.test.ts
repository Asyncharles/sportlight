import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import amqp from 'amqplib';
import { FeedEventConsumer } from './amqp-consumer.js';
import { createLogger } from './logger.js';

afterEach(() => vi.restoreAllMocks());

it('replaces a broker-cancelled consumer and reports readiness correctly', async () => {
  const channels: Array<EventEmitter & Record<string, any>> = [];
  vi.spyOn(amqp, 'connect').mockImplementation(async () => {
    const connection = new EventEmitter() as EventEmitter & Record<string, any>;
    const channel = new EventEmitter() as EventEmitter & Record<string, any>;
    for (const method of ['assertExchange', 'assertQueue', 'bindQueue', 'prefetch', 'close']) channel[method] = vi.fn(async () => {});
    channel.consume = vi.fn(async (_queue, callback) => { channel.callback = callback; });
    connection.createChannel = async () => channel;
    connection.close = vi.fn(async () => { connection.emit('close'); });
    channels.push(channel);
    return connection as any;
  });
  const consumer = new FeedEventConsumer({url: 'amqp://test', queue:'test', prefetch: 1, onEvent() {}, log: createLogger('test')});
  consumer.start();
  await vi.waitFor(() => expect(consumer.stats.connected).toBe(true));
  channels[0]!.callback(null);
  expect(consumer.stats.connected).toBe(false);
  await vi.waitFor(() => expect(channels).toHaveLength(2));
  await vi.waitFor(() => expect(consumer.stats.connected).toBe(true));
  expect(consumer.stats.reconnects).toBe(1);
  channels[1]!.emit('error', new Error('channel failure'));
  channels[1]!.emit('close');
  await vi.waitFor(() => expect(channels).toHaveLength(3));
  await consumer.stop();
});

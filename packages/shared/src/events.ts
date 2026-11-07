import type { EndReason, EventInfo, FeedId, MediaSource, RunId, SportId } from './domain.js';

/**
 * Provider → backend events, carried over RabbitMQ.
 *
 * Ordering model:
 *  - A feed broadcasts in *runs*. `runId` + `runStartedAt` identify a run; a run with an earlier
 *    `runStartedAt` than the one the backend holds is outdated and ignored.
 *  - Within a run, `seq` increases monotonically. Events with `seq` ≤ the last applied value are
 *    duplicates or late arrivals and never overwrite newer state.
 *  - `eventId` is unique per message and lets consumers drop exact redeliveries cheaply.
 */

export const FEED_EVENT_SCHEMA_VERSION = 1 as const;

export const AMQP_TOPOLOGY = {
  exchange: 'sportlight.feeds',
  exchangeType: 'topic',
  /** Dead-letter exchange for messages that fail validation. */
  deadLetterExchange: 'sportlight.feeds.dlx',
  deadLetterQueue: 'sportlight.feeds.dead',
  /** Binding pattern that matches every feed event. */
  bindingKey: 'feed.#',
} as const;

export type FeedEventType = 'feed.started' | 'feed.intensity' | 'feed.updated' | 'feed.ended';

/** Routing key: `feed.<type>.<sport>.<feedId>` so consumers can subscribe selectively. */
export function routingKeyFor(event: Pick<AnyFeedEvent, 'type' | 'feedId'>, sportId: SportId): string {
  return `feed.${event.type.slice('feed.'.length)}.${sportId}.${event.feedId}`;
}

interface EnvelopeBase<T extends FeedEventType, P> {
  schemaVersion: typeof FEED_EVENT_SCHEMA_VERSION;
  type: T;
  eventId: string;
  provider: string;
  feedId: FeedId;
  runId: RunId;
  /** ISO timestamp at which the run started (stream time 0). */
  runStartedAt: string;
  /** Monotonic per run. */
  seq: number;
  /** ISO timestamp at which the provider emitted the event. */
  occurredAt: string;
  payload: P;
}

export interface FeedStartedPayload {
  sportId: SportId;
  event: EventInfo;
  source: MediaSource;
}

export interface IntensityPayload {
  /** 0–100. */
  score: number;
  /** Seconds since the run started; maps the reading onto the media timeline. */
  streamTime: number;
}

export interface FeedUpdatedPayload {
  sportId?: SportId;
  event?: EventInfo;
  source?: MediaSource;
  availability?: 'available' | 'unavailable';
}

export interface FeedEndedPayload {
  reason: EndReason;
}

export type FeedStartedEvent = EnvelopeBase<'feed.started', FeedStartedPayload>;
export type IntensityUpdatedEvent = EnvelopeBase<'feed.intensity', IntensityPayload>;
export type FeedUpdatedEvent = EnvelopeBase<'feed.updated', FeedUpdatedPayload>;
export type FeedEndedEvent = EnvelopeBase<'feed.ended', FeedEndedPayload>;

export type AnyFeedEvent = FeedStartedEvent | IntensityUpdatedEvent | FeedUpdatedEvent | FeedEndedEvent;

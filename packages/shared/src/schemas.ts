/**
 * Runtime validation for messages crossing a trust boundary (RabbitMQ → backend, browser →
 * backend). Exposed as a separate entry point (`@sportlight/shared/schemas`) so the web bundle does
 * not pull in zod.
 */
import { z } from 'zod';
import type { AnyFeedEvent } from './events.js';
import { FEED_EVENT_SCHEMA_VERSION } from './events.js';
import type { ClientMessage } from './ws.js';

const isoDate = z.string().datetime({ offset: true });
const id = z.string().min(1).max(128);

export const EventInfoSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).optional(),
  competitionId: id.optional(),
  teamIds: z.array(id).max(16).optional(),
  venue: z.string().max(200).optional(),
  broadcaster: z.object({ name: z.string().min(1).max(120), channel: z.string().max(120).optional() }).optional(),
  extra: z.boolean().optional(),
});

export const MediaSourceSchema = z.object({
  kind: z.literal('looping-mp4'),
  url: z.string().min(1).max(2048),
  durationSec: z.number().positive(),
  mediaOffsetSec: z.number().nonnegative(),
  hasAudio: z.boolean(),
  posterUrl: z.string().max(2048).optional(),
  credits: z
    .array(
      z.object({
        title: z.string().max(2000),
        author: z.string().max(4000),
        license: z.string().max(200),
        licenseUrl: z.string().max(2048).nullable(),
        sourceUrl: z.string().max(2048),
      }),
    )
    .max(32)
    .optional(),
  attributionNotice: z.string().max(2000).optional(),
  thumbnails: z
    .object({
      template: z.string().max(2048).includes('{index}'),
      intervalSec: z.number().positive(),
      count: z.number().int().nonnegative(),
    })
    .optional(),
});

const envelope = {
  schemaVersion: z.literal(FEED_EVENT_SCHEMA_VERSION),
  eventId: id,
  provider: id,
  feedId: id,
  runId: id,
  runStartedAt: isoDate,
  seq: z.number().int().nonnegative(),
  occurredAt: isoDate,
};

export const FeedEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('feed.started'),
    payload: z.object({ sportId: id, event: EventInfoSchema, source: MediaSourceSchema }),
  }),
  z.object({
    ...envelope,
    type: z.literal('feed.intensity'),
    payload: z.object({ score: z.number().min(0).max(100), streamTime: z.number().nonnegative() }),
  }),
  z.object({
    ...envelope,
    type: z.literal('feed.updated'),
    payload: z.object({
      sportId: id.optional(),
      event: EventInfoSchema.optional(),
      source: MediaSourceSchema.optional(),
      availability: z.enum(['available', 'unavailable']).optional(),
    }),
  }),
  z.object({
    ...envelope,
    type: z.literal('feed.ended'),
    payload: z.object({ reason: z.enum(['completed', 'cancelled', 'failed', 'timeout']) }),
  }),
]);

const FollowSchema = z.object({ kind: z.enum(['sport', 'competition', 'team']), id });
const SlotSchema = z.enum(['main', 'side-1', 'side-2', 'side-3']);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    viewerId: id,
    client: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('viewer.state'),
    follows: z.array(FollowSchema).max(200),
    tiles: z
      .array(
        z.object({
          slot: SlotSchema,
          feedId: id,
          lagSec: z.number().min(0).max(86_400),
          playback: z.enum(['playing', 'paused', 'buffering', 'loading', 'error']),
        }),
      )
      .max(4),
  }),
  z.object({
    type: z.literal('vote'),
    feedId: id,
    runId: id,
    value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  }),
  z.object({ type: z.literal('ping'), clientTime: z.number() }),
]);

// Compile-time checks that the schemas and the hand-written contract types agree.
type Assert<T extends true> = T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _FeedEventMatches = Assert<Same<z.infer<typeof FeedEventSchema>, AnyFeedEvent>>;
export type _ClientMessageMatches = Assert<Same<z.infer<typeof ClientMessageSchema>, ClientMessage>>;

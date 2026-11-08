import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import {
  AMQP_TOPOLOGY,
  FEED_EVENT_SCHEMA_VERSION,
  routingKeyFor,
  type AnyFeedEvent,
  type LoopingMp4Source,
  type MediaCredit,
} from '@sportlight/shared';
import { DEMO_FEEDS, inWindows, intensityAt, type DemoFeed } from './scenario.js';
import { openDatasetFeeds } from './open-dataset.js';

/**
 * Mock feed provider. Publishes the demo scenario to RabbitMQ exactly as a real provider adapter
 * would: lifecycle events, ~1 Hz intensity readings mapped to stream time, and periodic
 * re-announcements so a freshly started backend converges without replaying history.
 */

const env = process.env;
const config = {
  amqpUrl: env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672',
  /** URL or file path of the media catalog produced by media/build.mjs. */
  catalog: env.MEDIA_CATALOG ?? '../../media/dist/catalog.json',
  /** Base URL browsers use to fetch media (origin-relative by default). */
  mediaPublicBase: (env.MEDIA_PUBLIC_BASE ?? '/media').replace(/\/$/, ''),
  provider: env.PROVIDER_ID ?? 'mock-provider',
  seed: Number(env.SCENARIO_SEED ?? 20261107),
  /** Start part-way into the scenario (seconds). */
  offsetSec: Number(env.SCENARIO_OFFSET_SEC ?? 0),
  /** Scenario schedule speed-up for testing. Media always plays at real time. */
  speed: Number(env.SCENARIO_SPEED ?? 1),
  tickMs: Number(env.TICK_MS ?? 1000),
  reannounceSec: Number(env.REANNOUNCE_SEC ?? 10),
  chaos: {
    duplicateRate: Number(env.CHAOS_DUPLICATE_RATE ?? 0),
    delayRate: Number(env.CHAOS_DELAY_RATE ?? 0),
    invalidRate: Number(env.CHAOS_INVALID_RATE ?? 0),
  },
};

const log = (msg: string, fields?: Record<string, unknown>) =>
  console.log(
    `${new Date().toISOString().slice(11, 23)} [publisher] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`,
  );

// ---------------------------------------------------------------- media catalog

export interface CatalogClip {
  sportId?: string;
  dataset?: string;
  credits?: MediaCredit[];
  attributionNotice?: string;
  id: string;
  video: string;
  poster: string;
  durationSec: number;
  hasAudio: boolean;
  startOffsetSec?: number;
  event?: { title: string; subtitle: string; broadcaster: DemoFeed['broadcaster'] };
  thumbnails: { template: string; intervalSec: number; count: number };
}

async function loadCatalog(): Promise<Map<string, CatalogClip>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = /^https?:\/\//.test(config.catalog)
        ? await fetch(config.catalog).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
          })
        : await readFile(new URL(config.catalog, `file://${process.cwd()}/`), 'utf8');
      const clips = (JSON.parse(raw) as { clips: CatalogClip[] }).clips;
      return new Map(clips.map((c) => [c.id, c]));
    } catch (err) {
      const delay = Math.min(10_000, 1000 * 2 ** attempt);
      log('media catalog unavailable, retrying', { catalog: config.catalog, err: (err as Error).message, inMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function sourceFor(clip: CatalogClip): LoopingMp4Source {
  const base = config.mediaPublicBase;
  return {
    kind: 'looping-mp4',
    url: `${base}/${clip.video}`,
    durationSec: clip.durationSec,
    // Begin inside the broadcast instead of randomly landing in an interval or credits.
    mediaOffsetSec: Math.min(clip.startOffsetSec ?? 0, Math.max(0, clip.durationSec - 1)),
    hasAudio: clip.hasAudio,
    credits: clip.credits,
    attributionNotice: clip.attributionNotice,
    posterUrl: `${base}/${clip.poster}`,
    thumbnails: { ...clip.thumbnails, template: `${base}/${clip.thumbnails.template}` },
  };
}

// ---------------------------------------------------------------- AMQP

let stopping = false;
let conn: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;
/** Lifecycle events that could not be sent while disconnected; intensity is never buffered. */
const outbox: Array<{ key: string; body: Buffer; id: string }> = [];

async function connect(): Promise<void> {
  for (let attempt = 0; !stopping; attempt++) {
    let candidate: ChannelModel | null = null;
    try {
      const c = await amqp.connect(config.amqpUrl, {
        clientProperties: { connection_name: 'sportlight-mock-publisher' },
      });
      candidate = c;
      c.on('error', (err) => log('amqp error', { err: err.message }));
      const ch = await c.createConfirmChannel();
      ch.on('error', (err) => log('amqp channel error', { err: err.message }));
      ch.on('close', () => {
        void c.close().catch(() => {});
      });
      await ch.assertExchange(AMQP_TOPOLOGY.exchange, AMQP_TOPOLOGY.exchangeType, { durable: true });
      c.on('error', (err) => log('amqp error', { err: err.message }));
      c.on('close', () => {
        channel = null;
        conn = null;
        if (stopping) return;
        log('amqp connection closed, reconnecting');
        void connect().then(onReconnected);
      });
      conn = c;
      channel = ch;
      log('connected to RabbitMQ');
      while (outbox.length) {
        const m = outbox.shift()!;
        rawPublish(m.key, m.body, m.id, true);
      }
      return;
    } catch (err) {
      await candidate?.close().catch(() => {});
      const delay = Math.min(15_000, 500 * 2 ** attempt);
      const e = err as Error & { code?: string; errors?: Array<{ code?: string }> };
      const reason = e.message || e.code || e.errors?.map((x) => x.code).join(', ') || String(err);
      log('amqp connect failed, retrying', { err: reason, inMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function rawPublish(key: string, body: Buffer, id: string, lifecycle: boolean) {
  if (!channel) {
    if (lifecycle && outbox.length < 1000) outbox.push({ key, body, id });
    return;
  }
  const publishingConnection = conn;
  channel.publish(
    AMQP_TOPOLOGY.exchange,
    key,
    body,
    {
      messageId: id,
      contentType: 'application/json',
      persistent: lifecycle,
      timestamp: Math.floor(Date.now() / 1000),
    },
    (err: Error | null) => {
      if (err && lifecycle && outbox.length < 1000) {
        outbox.push({ key, body, id });
        if (!stopping) void publishingConnection?.close().catch(() => {});
      }
    },
  );
}

function publish(event: AnyFeedEvent, sportId: string) {
  const key = routingKeyFor(event, sportId);
  const body = Buffer.from(JSON.stringify(event));
  const lifecycle = event.type !== 'feed.intensity';
  const { duplicateRate, delayRate, invalidRate } = config.chaos;

  if (!lifecycle && Math.random() < invalidRate) {
    rawPublish(key, Buffer.from('{"schemaVersion":1,"type":"feed.intensity","garbage":true}'), randomUUID(), false);
  }
  if (!lifecycle && Math.random() < delayRate) {
    // Arrives after newer readings: the backend must back-fill history without regressing state.
    setTimeout(() => rawPublish(key, body, event.eventId, false), 2_000 + Math.random() * 2_000);
    return;
  }
  rawPublish(key, body, event.eventId, lifecycle);
  if (Math.random() < duplicateRate) rawPublish(key, body, event.eventId, lifecycle); // redelivery
}

// ---------------------------------------------------------------- scenario runner

interface Run {
  runId: string;
  startedAtMs: number;
  seq: number;
  source: LoopingMp4Source;
  unavailable: boolean;
  lastAnnounceMs: number;
}

const runs = new Map<string, Run>();
const activeFeeds: DemoFeed[] = [...DEMO_FEEDS];

function envelope<T extends AnyFeedEvent['type']>(
  feed: DemoFeed,
  run: Run,
  type: T,
  payload: Extract<AnyFeedEvent, { type: T }>['payload'],
) {
  return {
    schemaVersion: FEED_EVENT_SCHEMA_VERSION,
    type,
    eventId: randomUUID(),
    provider: config.provider,
    feedId: feed.id,
    runId: run.runId,
    runStartedAt: new Date(run.startedAtMs).toISOString(),
    seq: ++run.seq,
    occurredAt: new Date().toISOString(),
    payload,
  } as AnyFeedEvent;
}

function announce(feed: DemoFeed, run: Run, now: number) {
  run.lastAnnounceMs = now;
  publish(
    envelope(feed, run, 'feed.started', {
      sportId: feed.sportId,
      event: {
        title: feed.title,
        subtitle: feed.subtitle,
        ...(feed.competitionId ? { competitionId: feed.competitionId } : {}),
        ...(feed.teamIds ? { teamIds: feed.teamIds } : {}),
        ...(feed.venue ? { venue: feed.venue } : {}),
        broadcaster: feed.broadcaster,
      },
      source: run.source,
    }),
    feed.sportId,
  );
}

function step(catalog: Map<string, CatalogClip>, processStart: number) {
  const now = Date.now();
  const t = config.offsetSec + ((now - processStart) / 1000) * config.speed;

  for (const feed of activeFeeds) {
    const clip = catalog.get(feed.clipId);
    if (!clip) continue;
    const shouldBeLive = inWindows(feed.live, t);
    let run = runs.get(feed.id);

    if (shouldBeLive && !run) {
      run = {
        runId: `${feed.id}.${now.toString(36)}`,
        startedAtMs: now,
        seq: 0,
        source: sourceFor(clip),
        unavailable: false,
        lastAnnounceMs: 0,
      };
      runs.set(feed.id, run);
      announce(feed, run, now);
      log('feed started', { feedId: feed.id, runId: run.runId });
    } else if (!shouldBeLive && run) {
      publish(envelope(feed, run, 'feed.ended', { reason: 'completed' }), feed.sportId);
      runs.delete(feed.id);
      log('feed ended', { feedId: feed.id });
      continue;
    }
    if (!run) continue;

    const unavailable = inWindows(feed.outages, t);
    if (unavailable !== run.unavailable) {
      run.unavailable = unavailable;
      publish(
        envelope(feed, run, 'feed.updated', { availability: unavailable ? 'unavailable' : 'available' }),
        feed.sportId,
      );
      log(unavailable ? 'feed unavailable' : 'feed available again', { feedId: feed.id });
    }
    if (now - run.lastAnnounceMs >= config.reannounceSec * 1000) announce(feed, run, now);
    if (run.unavailable) continue; // an outage also silences intensity

    const streamTime = Math.round(((now - run.startedAtMs) / 1000) * 1000) / 1000;
    publish(
      envelope(feed, run, 'feed.intensity', { score: intensityAt(feed, t, config.seed), streamTime }),
      feed.sportId,
    );
  }
}

function onReconnected() {
  // The backend may have missed lifecycle events; re-announce every running feed.
  const now = Date.now();
  for (const feed of activeFeeds) {
    const run = runs.get(feed.id);
    if (run) announce(feed, run, now);
  }
}

async function main() {
  log('starting', { seed: config.seed, speed: config.speed, offsetSec: config.offsetSec, chaos: config.chaos });
  let catalog = await loadCatalog();
  activeFeeds.push(...openDatasetFeeds([...catalog.values()]));
  log('catalog loaded', { clips: catalog.size, feeds: activeFeeds.length });
  for (const feed of activeFeeds) {
    const event = catalog.get(feed.clipId)?.event;
    if (event) {
      Object.assign(feed, event);
      // Old scenario IDs are stable; old teams/venues must not describe the new replay.
      delete feed.teamIds;
      delete feed.venue;
      delete feed.competitionId;
    }
  }
  const missing = activeFeeds.filter((f) => !catalog.has(f.clipId)).map((f) => f.id);
  if (missing.length) log('feeds without media are skipped', { missing });
  await connect();

  const processStart = Date.now();
  step(catalog, processStart);
  const timer = setInterval(() => step(catalog, processStart), config.tickMs);
  let refreshing = false;
  const catalogTimer = setInterval(() => {
    if (refreshing || stopping) return;
    refreshing = true;
    void loadCatalog()
      .then((next) => {
        if (stopping) return;
        const known = new Set(activeFeeds.map((feed) => feed.id));
        const added = openDatasetFeeds([...next.values()]).filter((feed) => !known.has(feed.id));
        activeFeeds.push(...added);
        catalog = next;
        if (added.length) log('new test media activated', { added: added.length, clips: catalog.size });
      })
      .finally(() => {
        refreshing = false;
      });
  }, 15_000);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(catalogTimer);
    log('shutting down: ending all feeds');
    for (const feed of activeFeeds) {
      const run = runs.get(feed.id);
      if (run) publish(envelope(feed, run, 'feed.ended', { reason: 'cancelled' }), feed.sportId);
    }
    try {
      await channel?.waitForConfirms();
      await conn?.close();
    } catch {
      /* closing anyway */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('[publisher] fatal', err);
  process.exit(1);
});

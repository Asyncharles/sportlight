import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import {
  AMQP_TOPOLOGY,
  FEED_EVENT_SCHEMA_VERSION,
  routingKeyFor,
  type AnyFeedEvent,
  loopDelta,
  type LoopingMp4Source,
  type MediaCredit,
} from '@sportlight/shared';
import { DEMO_FEEDS, inWindows, intensityAt, type DemoFeed } from './scenario.js';
import { openDatasetFeeds } from './open-dataset.js';
import { planLive } from './live-slots.js';
import { FeedClocks, offsetFor, parseFeedsState, streamTimeFor } from './feed-clock.js';
import { followEngineScores, scoreTimeMs, type EngineScore } from './engine-scores.js';
import { LOCAL_DATASET, hasDemoClips, isExtraFeed, publishedLocalFeeds } from './local-feeds.js';

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
  /** URL or file path of the engine demo feeds' catalog (npm run media:local); optional. */
  localCatalog: env.MEDIA_LOCAL_CATALOG ?? '../../media/dist/local/catalog.json',
  /** all: demo scenario, open test clips and local engine feeds. local: only the local engine feeds. */
  feedSet: env.FEED_SET === 'local' ? 'local' : 'all',
  /** SportlightEngine's score stream, e.g. ws://localhost:8000/ws/scores. Unset: simulated intensity. */
  engineScoresUrl: env.ENGINE_SCORES_URL ?? '',
  /** URL or file path of the engine pushers' run/feeds_state.json (each feed's start time). */
  feedsState: env.FEEDS_STATE ?? '',
  /** SportlightEngine announces the four demo feeds itself; publish only the extra feeds. */
  engineOwnsDemoFeeds: ['1', 'true'].includes((env.ENGINE_OWNS_DEMO_FEEDS ?? '').toLowerCase()),
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
  /** Most feeds live at once (0 = unlimited); scheduled feeds beyond this wait for a slot. */
  maxLiveFeeds: Number(env.MAX_LIVE_FEEDS ?? 10),
  /** When feeds are waiting, a feed hands over its slot after this long on air. */
  liveRotateSec: Number(env.LIVE_ROTATE_SEC ?? 300),
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
  synthetic?: boolean;
  credits?: MediaCredit[];
  attributionNotice?: string;
  id: string;
  video: string;
  poster: string;
  durationSec: number;
  hasAudio: boolean;
  startOffsetSec?: number;
  competitionId?: string;
  event?: { title: string; subtitle: string; broadcaster: DemoFeed['broadcaster'] };
  thumbnails: { template: string; intervalSec: number; count: number };
}

async function readSource(location: string): Promise<string> {
  return /^https?:\/\//.test(location)
    ? await fetch(location).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
    : await readFile(new URL(location, `file://${process.cwd()}/`), 'utf8');
}

/** The local engine feeds' catalog is optional: missing means no local feeds. */
async function loadLocalCatalog(): Promise<CatalogClip[]> {
  try {
    return (JSON.parse(await readSource(config.localCatalog)) as { clips: CatalogClip[] }).clips;
  } catch {
    return [];
  }
}

async function loadCatalog(): Promise<Map<string, CatalogClip>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const local = await loadLocalCatalog();
      const clips =
        config.feedSet === 'local' ? [] : (JSON.parse(await readSource(config.catalog)) as { clips: CatalogClip[] }).clips;
      return new Map([...clips, ...local].map((c) => [c.id, c]));
    } catch (err) {
      const delay = Math.min(10_000, 1000 * 2 ** attempt);
      log('media catalog unavailable, retrying', { catalog: config.catalog, err: (err as Error).message, inMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function sourceFor(clip: CatalogClip, runStartMs: number): LoopingMp4Source {
  const base = config.mediaPublicBase;
  const clockStart = clocks.startFor(clip.id);
  return {
    kind: 'looping-mp4',
    url: `${base}/${clip.video}`,
    durationSec: clip.durationSec,
    // Engine feeds play where the engine is (shared clock); others begin inside the broadcast instead
    // of randomly landing in an interval or credits.
    mediaOffsetSec:
      clockStart !== undefined
        ? offsetFor(runStartMs, clockStart, clip.durationSec)
        : Math.min(clip.startOffsetSec ?? 0, Math.max(0, clip.durationSec - 1)),
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
const activeFeeds: DemoFeed[] = config.feedSet === 'local' ? [] : [...DEMO_FEEDS];
const clocks = new FeedClocks();
/** Engine scores replace simulated intensity for local feeds while the engine is configured. */
/** The engine's demo clips are in the media catalog (refreshed with it). */
let demoClipsPresent = false;
const engineDriven = (feedId: string, catalog: Map<string, CatalogClip>) =>
  Boolean(config.engineScoresUrl) && catalog.get(feedId)?.dataset === LOCAL_DATASET;

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
        // With the engine's demo feeds on air, everything else is extra (hidden until a viewer opts in).
        ...(isExtraFeed(feed, demoClipsPresent) ? { extra: true } : {}),
      },
      source: run.source,
    }),
    feed.sportId,
  );
}

const lastEndedMs = new Map<string, number>();

function step(catalog: Map<string, CatalogClip>, processStart: number) {
  const now = Date.now();
  const t = config.offsetSec + ((now - processStart) / 1000) * config.speed;
  const byId = new Map(activeFeeds.map((feed) => [feed.id, feed]));

  const plan = planLive({
    wanted: activeFeeds.filter((feed) => catalog.has(feed.clipId) && inWindows(feed.live, t)).map((feed) => feed.id),
    running: new Map([...runs].map(([id, run]) => [id, run.startedAtMs])),
    lastEndedMs,
    now,
    max: config.maxLiveFeeds,
    rotateMs: config.liveRotateSec * 1000,
    pinned: new Set(activeFeeds.filter((feed) => feed.pinned).map((feed) => feed.id)),
  });
  for (const id of plan.stop) {
    const feed = byId.get(id)!;
    publish(envelope(feed, runs.get(id)!, 'feed.ended', { reason: 'completed' }), feed.sportId);
    runs.delete(id);
    lastEndedMs.set(id, now);
    log('feed ended', { feedId: id });
  }
  for (const id of plan.start) {
    const feed = byId.get(id)!;
    const run: Run = {
      runId: `${feed.id}.${now.toString(36)}`,
      startedAtMs: now,
      seq: 0,
      source: sourceFor(catalog.get(feed.clipId)!, now),
      unavailable: false,
      lastAnnounceMs: 0,
    };
    runs.set(feed.id, run);
    announce(feed, run, now);
    log('feed started', { feedId: feed.id, runId: run.runId, live: runs.size });
  }

  for (const feed of activeFeeds) {
    const run = runs.get(feed.id);
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
    syncClock(feed, run, catalog.get(feed.clipId)!);
    if (now - run.lastAnnounceMs >= config.reannounceSec * 1000) announce(feed, run, now);
    if (run.unavailable) continue; // an outage also silences intensity
    if (engineDriven(feed.id, catalog)) continue; // intensity comes from the engine's scores

    const streamTime = Math.round(((now - run.startedAtMs) / 1000) * 1000) / 1000;
    publish(
      envelope(feed, run, 'feed.intensity', { score: intensityAt(feed, t, config.seed), streamTime }),
      feed.sportId,
    );
  }
}

/** Moves a running feed's media offset when its shared clock changed (pusher restart, engine anchor). */
function syncClock(feed: DemoFeed, run: Run, clip: CatalogClip) {
  const clockStart = clocks.startFor(clip.id);
  if (clockStart === undefined) return;
  const offset = offsetFor(run.startedAtMs, clockStart, clip.durationSec);
  if (Math.abs(loopDelta(run.source.mediaOffsetSec, offset, clip.durationSec)) < 0.25) return;
  run.source = { ...run.source, mediaOffsetSec: offset };
  publish(envelope(feed, run, 'feed.updated', { source: run.source }), feed.sportId);
  log('feed clock synced', { feedId: feed.id, from: clocks.sourceOf(clip.id), mediaOffsetSec: offset });
}

function onEngineScore(score: EngineScore, receivedAtMs: number, catalog: Map<string, CatalogClip>) {
  const clip = catalog.get(score.feed_id);
  const feed = activeFeeds.find((f) => f.id === score.feed_id);
  if (!clip || clip.dataset !== LOCAL_DATASET || !feed) return;
  clocks.noteScore(score.feed_id, score.t_video, score.loop_epoch, clip.durationSec, scoreTimeMs(score, receivedAtMs));
  const run = runs.get(score.feed_id);
  if (!run || run.unavailable || score.stale) return;
  syncClock(feed, run, clip);
  const streamTime = streamTimeFor(score, clocks.startFor(clip.id)!, run.startedAtMs, clip.durationSec);
  if (streamTime < 0) return; // a moment from before this run started
  publish(envelope(feed, run, 'feed.intensity', { score: Math.round(score.intensity_pct), streamTime }), feed.sportId);
}

async function refreshFeedsState() {
  if (!config.feedsState) return;
  try {
    clocks.setPusherStarts(parseFeedsState(JSON.parse(await readSource(config.feedsState))));
  } catch (err) {
    log('feeds_state unavailable', { feedsState: config.feedsState, err: (err as Error).message });
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
  log('catalog loaded', { clips: catalog.size, feeds: activeFeeds.length, maxLive: config.maxLiveFeeds });
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
  demoClipsPresent = hasDemoClips([...catalog.values()]);
  activeFeeds.push(...publishedLocalFeeds([...catalog.values()], config.engineOwnsDemoFeeds));
  const missing = activeFeeds.filter((f) => !catalog.has(f.clipId)).map((f) => f.id);
  if (missing.length) log('feeds without media are skipped', { missing });
  await refreshFeedsState();
  const feedsStateTimer = setInterval(() => void refreshFeedsState(), 5_000);
  const stopEngine = config.engineScoresUrl
    ? followEngineScores(config.engineScoresUrl, (score, at) => onEngineScore(score, at, catalog), log)
    : () => {};
  log('feed clock', {
    feedsState: config.feedsState || null,
    engineScores: config.engineScoresUrl || null,
    localFeeds: activeFeeds.filter((f) => f.pinned).map((f) => f.id),
    engineOwnsDemoFeeds: config.engineOwnsDemoFeeds,
    demoClipsPresent,
  });
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
        const added = [
          ...(config.feedSet === 'local' ? [] : openDatasetFeeds([...next.values()])),
          ...publishedLocalFeeds([...next.values()], config.engineOwnsDemoFeeds),
        ].filter((feed) => !known.has(feed.id));
        activeFeeds.push(...added);
        catalog = next;
        demoClipsPresent = hasDemoClips([...next.values()]);
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
    clearInterval(feedsStateTimer);
    stopEngine();
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

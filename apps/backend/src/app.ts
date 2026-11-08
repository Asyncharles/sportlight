import { createReadStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  isKnownSport,
  type AdminFeed,
  type AdminOverview,
  type AnyFeedEvent,
  type ClientConfig,
  type ClientMessage,
  type FeedState,
  type Highlight,
} from '@sportlight/shared';
import { ContentService } from './content/service.js';
import { FeedEventConsumer } from './amqp-consumer.js';
import type { BackendConfig } from './config.js';
import { FeedStore } from './feeds/feed-store.js';
import { IntensityHistory } from './feeds/history.js';
import { MomentDetector, type Moment } from './highlights/detector.js';
import { GeminiCaptioner, HighlightCaptioner, type CaptionModel } from './highlights/captioner.js';
import { LocalCaptioner } from './highlights/local-captioner.js';
import { HighlightStills } from './highlights/stills.js';
import { HighlightStore } from './highlights/store.js';
import type { Logger } from './logger.js';
import { ViewerRegistry } from './viewers.js';
import { WsHub } from './ws-hub.js';

const startedAt = Date.now();

/** Wires the event pipeline: RabbitMQ → feed store → history/highlights → WebSocket + REST. */
export async function createApp(config: BackendConfig, log: Logger) {
  const store = new FeedStore(config);
  const history = new IntensityHistory(
    config.dataDir,
    config.historyLimit,
    config.highlights.timezone,
    log.child('history'),
  );
  const detector = new MomentDetector(config.highlights);
  const captioner = new HighlightCaptioner({
    model: captionModel(config),
    mediaFetchBase: config.captions.mediaFetchBase,
    mediaPublicPrefix: config.captions.mediaPublicPrefix,
    ffmpegPath: config.content.ffmpegPath,
    log: log.child('captions'),
    onCaption: (id, caption) => {
      const updated = highlights.setCaption(id, caption);
      if (updated) hub.broadcast({ type: 'highlight', highlight: updated });
    },
  });
  const highlights = new HighlightStore(
    config.dataDir,
    config.highlights,
    log.child('highlights'),
    true,
    (h, previous) => captioner.instant(h, previous),
  );
  const stills = new HighlightStills(
    config.dataDir,
    {
      mediaFetchBase: config.captions.mediaFetchBase,
      mediaPublicPrefix: config.captions.mediaPublicPrefix,
      ffmpegPath: config.content.ffmpegPath,
    },
    log.child('stills'),
  );
  const viewers = new ViewerRegistry();
  await history.init();
  await highlights.init();
  // Name anything loaded from disk that has no caption yet (e.g. cut before captions existed).
  captioner.restore(highlights.all());
  for (const h of highlights.all()) {
    if (!h.caption || h.caption.model === 'template') highlights.setCaption(h.id, captioner.instant(h));
    captioner.enqueue(highlights.get(h.id)!);
  }
  const content = new ContentService(config, () => highlights.all(), log.child('content'));
  await content.init();
  log.info('highlight captions', { model: captioner.stats.model });

  const clientConfig: ClientConfig = {
    selection: config.selection,
    highlights: { timezone: config.highlights.timezone, enterThreshold: config.highlights.enterThreshold },
    staleAfterMs: config.staleAfterMs,
  };

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error('request failed', { err, path: new URL(req.url ?? '/', 'http://local').pathname });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  });

  const hub = new WsHub({
    server,
    config: clientConfig,
    broadcastIntervalMs: config.broadcastIntervalMs,
    snapshot: () => store.snapshot(),
    onConnect: (sessionId) => viewers.connect(sessionId),
    onDisconnect: (sessionId) => viewers.disconnect(sessionId),
    onMessage: (sessionId, msg) => onClientMessage(sessionId, msg),
    log: log.child('ws'),
  });

  // ------------------------------------------------------------------ event pipeline

  function emitMoment(moment: Moment | null, feed: FeedState) {
    if (!moment) return;
    const changes = highlights.addMoment(moment, feed, (from, to) =>
      history.range(moment.feedId, moment.runId, from, to),
    );
    for (const id of changes.removed) {
      captioner.forget(id);
      hub.broadcast({ type: 'highlight.removed', id });
    }
    for (const h of changes.upserted) {
      hub.broadcast({ type: 'highlight', highlight: h });
      captioner.enqueue(h);
      log.info('highlight', { feed: h.feedId, peak: h.peak.score, duration: h.clip.durationSec });
    }
  }

  function onFeedEvent(event: AnyFeedEvent, receivedAt: number) {
    const outcome = store.apply(event, receivedAt);
    switch (outcome.kind) {
      case 'dropped':
        log.debug('dropped event', { reason: outcome.reason, feedId: event.feedId, seq: event.seq });
        return;
      case 'late-intensity':
        history.add(outcome.feedId, outcome.runId, outcome.reading); // back-fill only
        return;
      case 'applied': {
        const feed = outcome.feed;
        if (outcome.replacedRunId) {
          viewers.clearRun(feed.id, outcome.replacedRunId);
          detector.flush(feed.id, outcome.replacedRunId);
        }
        if (outcome.reading) {
          history.add(feed.id, feed.runId, outcome.reading);
          emitMoment(detector.push(feed, outcome.reading), feed);
        }
        if (outcome.ended) emitMoment(detector.flush(feed.id, feed.runId), feed);
        if (outcome.started) log.info('feed started', { feedId: feed.id, runId: feed.runId, sport: feed.sportId });
        if (outcome.ended) log.info('feed ended', { feedId: feed.id, reason: feed.endReason });
        hub.queueFeed(feed);
      }
    }
  }

  function onClientMessage(sessionId: string, msg: ClientMessage) {
    switch (msg.type) {
      case 'hello':
        viewers.hello(sessionId, msg.viewerId, msg.client);
        return;
      case 'viewer.state':
        viewers.updateState(sessionId, msg.follows, msg.tiles);
        return;
      case 'vote': {
        const viewerId = viewers.list().find((v) => v.sessionId === sessionId)?.viewerId;
        if (!viewerId) return;
        const feed = store.get(msg.feedId);
        if (!feed || feed.runId !== msg.runId) return;
        const updated = store.setVotes(msg.feedId, msg.runId, viewers.vote(viewerId, msg.feedId, msg.runId, msg.value));
        if (updated) hub.queueFeed(updated);
        return;
      }
      case 'ping':
        return; // answered by the hub
    }
  }

  const consumer = new FeedEventConsumer({
    url: config.amqpUrl,
    queue: config.amqpQueue,
    prefetch: config.amqpPrefetch,
    onEvent: onFeedEvent,
    log: log.child('amqp'),
  });

  const tickTimer = setInterval(() => {
    const now = Date.now();
    const { changed, removed, ended } = store.tick(now);
    for (const feed of ended) emitMoment(detector.flush(feed.id, feed.runId), feed);
    for (const feed of changed) hub.queueFeed(feed);
    for (const id of removed) hub.broadcast({ type: 'feed.removed', feedId: id });
  }, 1_000);
  const pruneTimer = setInterval(() => history.prune(3_600_000), 60_000);

  // ------------------------------------------------------------------ HTTP

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    if (await content.route(req, res, url)) return;
    applyCors(req, res, config.corsOrigins);
    if (url.pathname === '/api/admin/storage/clear' && req.method === 'POST') {
      // Custom header prevents cross-site form submissions (the admin API is open in this PoC).
      if (req.headers['x-sportlight-action'] !== 'clear-archived-storage')
        return sendJson(res, 403, { error: 'invalid_action' });
      const target = url.searchParams.get('target') ?? 'archives';
      if (target === 'highlights') {
        // Every day's "Best of today", including today's: drop them from viewers' lists too.
        const cleared = await highlights.clear();
        for (const id of cleared.removed) {
          captioner.forget(id);
          hub.broadcast({ type: 'highlight.removed', id });
        }
        return sendJson(res, 200, { files: cleared.files, bytes: cleared.bytes, items: cleared.removed.length });
      }
      if (target === 'history') return sendJson(res, 200, await clearFiles(['history'], /^\d{4}-\d{2}-\d{2}\.ndjson$/));
      if (target === 'archives')
        return sendJson(
          res,
          200,
          await clearFiles(['history', 'highlights'], /^\d{4}-\d{2}-\d{2}\.(json|ndjson)$/, Date.now() - 7 * 86_400_000),
        );
      return sendJson(res, 400, { error: 'invalid_target' });
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });

    const path = url.pathname;
    if (path === '/healthz') return sendJson(res, 200, { ok: true });
    if (path === '/readyz')
      return sendJson(res, consumer.stats.connected ? 200 : 503, { amqp: consumer.stats.connected });
    if (path === '/api/config') return sendJson(res, 200, clientConfig);
    if (path === '/api/feeds') return sendJson(res, 200, { serverTime: Date.now(), feeds: store.snapshot() });
    if (path === '/api/feeds/recent') {
      // Recent intensity per live run, so clients can draw trend lines straight after connecting.
      const sec = Math.min(600, Math.max(5, Number(url.searchParams.get('sec')) || 90));
      const recent = Object.fromEntries(
        store.snapshot().map((f) => [
          f.id,
          {
            runId: f.runId,
            points: history.recent(f.id, f.runId, sec).map((p): [number, number] => [p.streamTime, p.score]),
          },
        ]),
      );
      return sendJson(res, 200, { serverTime: Date.now(), sec, feeds: recent });
    }

    if (path === '/api/highlights') {
      const day = url.searchParams.get('day') || highlights.today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { error: 'invalid_day' });
      const sports = url.searchParams.get('sports')?.split(',').filter(isKnownSport);
      let list: Highlight[] = highlights.list(day);
      if (sports?.length) list = list.filter((h) => sports.includes(h.sportId));
      return sendJson(res, 200, { day, timezone: config.highlights.timezone, highlights: list });
    }
    const still = path.match(/^\/api\/highlights\/([a-f0-9]{6,40})\/still\.jpg$/);
    if (still) {
      const h = highlights.get(still[1]!);
      const file = h ? await stills.file(h) : null;
      if (!file) return sendJson(res, 404, { error: 'not_found' });
      // The URL carries the peak second (?t=), so one URL always means the same image.
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': (await stat(file)).size,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      createReadStream(file).pipe(res);
      return;
    }
    const hl = path.match(/^\/api\/highlights\/([a-f0-9]{6,40})$/);
    if (hl) {
      const h = highlights.get(hl[1]!);
      return h ? sendJson(res, 200, h) : sendJson(res, 404, { error: 'not_found' });
    }

    if (path === '/api/admin/overview') {
      return sendJson(res, 200, adminOverview());
    }
    return sendJson(res, 404, { error: 'not_found' });
  }

  /** Deletes daily data files in the given folders; with `before`, only days (and files) older than it. */
  async function clearFiles(folders: string[], pattern: RegExp, before?: number) {
    let files = 0;
    let bytes = 0;
    for (const folder of folders) {
      const dir = join(config.dataDir, folder);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!pattern.test(name)) continue;
        if (before !== undefined && Date.parse(name.slice(0, 10) + 'T23:59:59Z') >= before) continue;
        const file = join(dir, name);
        const info = await stat(file);
        if (before !== undefined && info.mtimeMs >= before) continue;
        await unlink(file);
        files++;
        bytes += info.size;
      }
    }
    return { files, bytes };
  }

  function adminOverview(): AdminOverview {
    const now = Date.now();
    const feeds = [...store.recordsView().values()].map((r): AdminFeed => {
      const s = r.state;
      const watch = viewers.watching(s.id);
      return {
        id: s.id,
        runId: s.runId,
        provider: s.provider,
        sportId: s.sportId,
        title: s.event.title,
        subtitle: s.event.subtitle ?? null,
        status: s.status,
        unavailableReason: s.unavailableReason ?? null,
        endReason: s.endReason ?? null,
        startedAt: s.startedAt,
        uptimeSec: Math.max(0, (now - r.runStartedAtMs) / 1000),
        seq: s.seq,
        intensity: s.intensity,
        intensityStale: s.intensityStale,
        lastEventAgeMs: now - r.lastEventReceivedAt,
        lastIntensityAgeMs: r.lastIntensityReceivedAt === null ? null : now - r.lastIntensityReceivedAt,
        /** How far the newest reading's stream time trails the live edge. */
        streamLagSec:
          s.intensity && s.status !== 'ended'
            ? Math.max(0, (now - r.runStartedAtMs) / 1000 - s.intensity.streamTime)
            : null,
        deliveryLagMs: r.stats.lastLagMs,
        avgDeliveryLagMs: r.stats.avgLagMs === null ? null : Math.round(r.stats.avgLagMs),
        events: { applied: r.stats.applied, lateIntensity: r.stats.lateIntensity, dropped: r.stats.dropped },
        votes: s.votes,
        viewers: watch.viewers,
        mainViewers: watch.mainViewers,
        avgViewerLagSec: watch.avgLagSec,
        media: { url: s.source.url, durationSec: s.source.durationSec },
        recent: history.recent(s.id, s.runId, 120).map((p): [number, number] => [p.streamTime, p.score]),
      };
    });
    return {
      serverTime: now,
      uptimeSec: (now - startedAt) / 1000,
      amqp: consumer.stats,
      events: store.totals,
      websocket: { clients: hub.size },
      viewers: viewers.list().map((v) => ({
        sessionId: v.sessionId,
        viewerId: v.viewerId,
        client: v.client,
        connectedSec: (now - v.connectedAt) / 1000,
        follows: v.follows,
        tiles: v.tiles,
        lastStateAgeMs: v.lastStateAt === null ? null : now - v.lastStateAt,
      })),
      highlights: {
        day: highlights.today(),
        count: highlights.list(highlights.today()).length,
        captions: { ...captioner.stats },
      },
      config: {
        selection: config.selection,
        highlights: config.highlights,
        staleAfterMs: config.staleAfterMs,
        silentAfterMs: config.silentAfterMs,
        expireAfterMs: config.expireAfterMs,
      },
      feeds,
    };
  }

  return {
    async start() {
      consumer.start();
      content.start();
      await new Promise<void>((resolve) => server.listen(config.port, resolve));
      log.info('backend listening', { port: config.port });
    },
    async stop() {
      captioner.stop();
      await content.stop();
      clearInterval(tickTimer);
      clearInterval(pruneTimer);
      await consumer.stop();
      await hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await highlights.flush();
      await history.close();
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function applyCors(req: IncomingMessage, res: ServerResponse, origins: string[]) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (origins.includes('*') || origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origins.includes('*') ? '*' : origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Sportlight-Action');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

function captionModel(config: BackendConfig): CaptionModel | null {
  const c = config.captions;
  if (c.provider === 'local') {
    return new LocalCaptioner({
      endpoint: c.localUrl,
      model: c.localModel,
      ffmpegPath: config.content.ffmpegPath,
      whisper: { path: config.content.whisperPath, model: config.content.whisperModel, dtw: config.content.whisperDtw },
    });
  }
  if (c.provider === 'gemini' && c.geminiApiKey) return new GeminiCaptioner(c.geminiApiKey, c.geminiModel);
  return null;
}

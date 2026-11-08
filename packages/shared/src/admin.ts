import type { HighlightConfig, SelectionConfig } from './config.js';
import type { EndReason, FeedStatus, Follow, IntensityReading, UnavailableReason } from './domain.js';
import type { ViewerTile } from './ws.js';

/** Response of `GET /api/admin/overview` — the operations view of every stream. */
export interface AdminOverview {
  serverTime: number;
  uptimeSec: number;
  amqp: {
    connected: boolean;
    queue: string;
    connectedSince: number | null;
    reconnects: number;
    received: number;
    invalid: number;
    ratePerSec: number;
    queueDepth: number | null;
    lastMessageAt: number | null;
    lastError: string | null;
  };
  events: {
    applied: number;
    lateIntensity: number;
    dropped: Partial<Record<string, number>>;
  };
  websocket: { clients: number };
  viewers: Array<{
    sessionId: string;
    viewerId: string | null;
    client: string | null;
    connectedSec: number;
    follows: Follow[];
    tiles: ViewerTile[];
    lastStateAgeMs: number | null;
  }>;
  highlights: {
    day: string;
    count: number;
    captions: { model: string; generated: number; failed: number; pending: number; lastError: string | null; pausedUntil: string | null };
  };
  config: {
    selection: SelectionConfig;
    highlights: HighlightConfig;
    staleAfterMs: number;
    silentAfterMs: number;
    expireAfterMs: number;
  };
  feeds: AdminFeed[];
}

export interface AdminFeed {
  id: string;
  runId: string;
  provider: string;
  sportId: string;
  title: string;
  subtitle: string | null;
  status: FeedStatus;
  unavailableReason: UnavailableReason | null;
  endReason: EndReason | null;
  startedAt: string;
  uptimeSec: number;
  seq: number;
  intensity: IntensityReading | null;
  intensityStale: boolean;
  /** Time since any event for this feed was received. */
  lastEventAgeMs: number;
  lastIntensityAgeMs: number | null;
  /** How far the newest intensity reading trails the live edge of the stream (seconds). */
  streamLagSec: number | null;
  /** Provider → backend delivery lag of the latest event (ms). */
  deliveryLagMs: number | null;
  avgDeliveryLagMs: number | null;
  events: { applied: number; lateIntensity: number; dropped: Partial<Record<string, number>> };
  votes: { up: number; down: number };
  viewers: number;
  mainViewers: number;
  /** Average playback lag behind live across viewers showing this feed (seconds). */
  avgViewerLagSec: number | null;
  media: { url: string; durationSec: number };
  /** Last ~2 minutes of intensity as [streamTime, score]. */
  recent: Array<[number, number]>;
}

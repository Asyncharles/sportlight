import type { ClientConfig } from './config.js';
import type { FeedId, FeedState, Follow, RunId, VoteValue } from './domain.js';
import type { Highlight } from './highlights.js';

/**
 * Backend ⇄ browser WebSocket protocol. Metadata and intensity only — video travels separately via
 * each feed's media URL.
 *
 * On every (re)connection the server sends `welcome` then a full `snapshot`, so a reconnecting
 * client simply replaces its feed map. Subsequent `feeds` messages are batched upserts.
 */

export const WS_PROTOCOL_VERSION = 1;
export const WS_PATH = '/ws';

export type SlotId = 'main' | 'side-1' | 'side-2' | 'side-3';

export type ServerMessage =
  | {
      type: 'welcome';
      protocolVersion: number;
      sessionId: string;
      serverTime: number;
      config: ClientConfig;
    }
  | { type: 'snapshot'; serverTime: number; feeds: FeedState[] }
  | { type: 'feeds'; serverTime: number; feeds: FeedState[] }
  | { type: 'feed.removed'; feedId: FeedId }
  | { type: 'highlight'; highlight: Highlight }
  | { type: 'highlight.removed'; id: string }
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'error'; code: string; message: string };

/** What one viewer currently has on screen — lets the backend (and admin) see per-viewer state. */
export interface ViewerTile {
  slot: SlotId;
  feedId: FeedId;
  /** Seconds behind the live edge (pause/buffering). */
  lagSec: number;
  playback: 'playing' | 'paused' | 'buffering' | 'loading' | 'error';
}

export type ClientMessage =
  | { type: 'hello'; protocolVersion: number; viewerId: string; client?: string }
  | { type: 'viewer.state'; follows: Follow[]; tiles: ViewerTile[] }
  | { type: 'vote'; feedId: FeedId; runId: RunId; value: VoteValue }
  | { type: 'ping'; clientTime: number };

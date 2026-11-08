import { join } from 'node:path';
import {
  DEFAULT_HIGHLIGHT_CONFIG,
  DEFAULT_SELECTION_CONFIG,
  DEFAULT_STALE_AFTER_MS,
  type HighlightConfig,
  type SelectionConfig,
} from '@sportlight/shared';

/** All runtime configuration, read once from the environment. */
export interface BackendConfig {
  port: number;
  amqpUrl: string;
  /** Queue this instance consumes from. Give each replica its own queue: state is per instance. */
  amqpQueue: string;
  amqpPrefetch: number;
  dataDir: string;
  corsOrigins: string[];
  /** When set, /api/admin/* requires `Authorization: Bearer <token>`. */
  adminToken: string | null;
  staleAfterMs: number;
  /** A feed with no events at all for this long is marked unavailable… */
  silentAfterMs: number;
  /** …and ended after this long. */
  expireAfterMs: number;
  /** How long ended feeds remain visible (admin, clients) before removal. */
  endedRetentionMs: number;
  /** Batch window for WebSocket fan-out. */
  broadcastIntervalMs: number;
  /** Intensity samples retained in memory per feed run. */
  historyLimit: number;
  selection: SelectionConfig;
  highlights: HighlightConfig;
  content: {
    appUrl: string; clientId: string; clientSecret: string; encryptionKey: string;
    allowedEmails: string[]; mediaBase: string; ffmpegPath: string; settleSeconds: number;
    /** whisper.cpp CLI and ggml model for commentary captions; captions fall back to the caption model without them. */
    whisperPath: string; whisperModel: string; whisperDtw?: string;
  };
  captions: {
    /** Gemini API key. Without one, highlights keep their deterministic template captions. */
    geminiApiKey: string | null;
    geminiModel: string;
    /** Where the backend fetches origin-relative media (video clips for the model). */
    mediaFetchBase: string | null;
    mediaPublicPrefix: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const num = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Config ${key} must be a number, got "${raw}"`);
    return n;
  };
  const str = (key: string, fallback: string) => env[key] || fallback;
  const timezone = str('HIGHLIGHT_TIMEZONE', DEFAULT_HIGHLIGHT_CONFIG.timezone);
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error(`HIGHLIGHT_TIMEZONE "${timezone}" is not a valid IANA timezone`);
  }

  const config: BackendConfig = {
    port: num('PORT', 4000),
    amqpUrl: str('AMQP_URL', 'amqp://guest:guest@localhost:5672'),
    amqpQueue: str('AMQP_QUEUE', 'sportlight.backend'),
    amqpPrefetch: num('AMQP_PREFETCH', 200),
    dataDir: str('DATA_DIR', './data'),
    corsOrigins: str('CORS_ORIGINS', '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminToken: env.ADMIN_TOKEN || null,
    staleAfterMs: num('STALE_AFTER_MS', DEFAULT_STALE_AFTER_MS),
    silentAfterMs: num('SILENT_AFTER_MS', 15_000),
    expireAfterMs: num('EXPIRE_AFTER_MS', 120_000),
    endedRetentionMs: num('ENDED_RETENTION_MS', 60_000),
    broadcastIntervalMs: num('BROADCAST_INTERVAL_MS', 250),
    historyLimit: num('HISTORY_LIMIT', 7_200),
    selection: {
      minDisplayMs: num('SELECTION_MIN_DISPLAY_MS', DEFAULT_SELECTION_CONFIG.minDisplayMs),
      replaceMargin: num('SELECTION_REPLACE_MARGIN', DEFAULT_SELECTION_CONFIG.replaceMargin),
      challengeMs: num('SELECTION_CHALLENGE_MS', DEFAULT_SELECTION_CONFIG.challengeMs),
      voteBoost: {
        up: num('SELECTION_VOTE_UP_BOOST', DEFAULT_SELECTION_CONFIG.voteBoost.up),
        down: num('SELECTION_VOTE_DOWN_BOOST', DEFAULT_SELECTION_CONFIG.voteBoost.down),
      },
    },
    highlights: {
      enterThreshold: num('HIGHLIGHT_ENTER_THRESHOLD', DEFAULT_HIGHLIGHT_CONFIG.enterThreshold),
      exitThreshold: num('HIGHLIGHT_EXIT_THRESHOLD', DEFAULT_HIGHLIGHT_CONFIG.exitThreshold),
      preRollSec: num('HIGHLIGHT_PRE_ROLL_SEC', DEFAULT_HIGHLIGHT_CONFIG.preRollSec),
      postRollSec: num('HIGHLIGHT_POST_ROLL_SEC', DEFAULT_HIGHLIGHT_CONFIG.postRollSec),
      minClipSec: num('HIGHLIGHT_MIN_CLIP_SEC', DEFAULT_HIGHLIGHT_CONFIG.minClipSec),
      maxClipSec: num('HIGHLIGHT_MAX_CLIP_SEC', DEFAULT_HIGHLIGHT_CONFIG.maxClipSec),
      mergeGapSec: num('HIGHLIGHT_MERGE_GAP_SEC', DEFAULT_HIGHLIGHT_CONFIG.mergeGapSec),
      dedupeByMedia: str('HIGHLIGHT_DEDUPE_BY_MEDIA', String(DEFAULT_HIGHLIGHT_CONFIG.dedupeByMedia)) !== 'false',
      timezone,
      maxPerDay: num('HIGHLIGHT_MAX_PER_DAY', DEFAULT_HIGHLIGHT_CONFIG.maxPerDay),
    },
    content: {
      appUrl: str('CONTENT_APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
      clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '',
      encryptionKey: env.CONTENT_ENCRYPTION_KEY || '',
      allowedEmails: (env.CONTENT_ALLOWED_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
      mediaBase: str('MEDIA_FETCH_BASE', 'http://localhost:5173/media'),
      ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'), settleSeconds: num('CONTENT_SETTLE_SECONDS', 30),
      whisperPath: str('WHISPER_PATH', 'whisper-cli'),
      whisperModel: str('WHISPER_MODEL', join(str('DATA_DIR', './data'), 'models', 'ggml-small.bin')),
      whisperDtw: env.WHISPER_DTW?.trim() || undefined,
    },
    captions: {
      geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
      geminiModel: str('GEMINI_MODEL', 'gemini-3.6-flash'),
      mediaFetchBase: str('MEDIA_FETCH_BASE', 'http://localhost:5173/media'),
      mediaPublicPrefix: str('MEDIA_PUBLIC_PREFIX', '/media'),
    },
  };

  if (config.highlights.exitThreshold > config.highlights.enterThreshold) {
    throw new Error('HIGHLIGHT_EXIT_THRESHOLD must not exceed HIGHLIGHT_ENTER_THRESHOLD');
  }
  if (config.highlights.minClipSec > config.highlights.maxClipSec) {
    throw new Error('HIGHLIGHT_MIN_CLIP_SEC must not exceed HIGHLIGHT_MAX_CLIP_SEC');
  }
  const appUrl = new URL(config.content.appUrl);
  if (appUrl.pathname !== '/' || appUrl.search || appUrl.hash || appUrl.username || appUrl.password ||
      (appUrl.protocol !== 'https:' && !(appUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(appUrl.hostname)))) {
    throw new Error('CONTENT_APP_URL must be an HTTPS origin (HTTP localhost is allowed for development)');
  }
  if (config.content.encryptionKey && !/^[a-f0-9]{64}$/i.test(config.content.encryptionKey)) {
    throw new Error('CONTENT_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hexadecimal characters');
  }
  if (config.content.settleSeconds < 5 || config.content.settleSeconds > 3600) throw new Error('CONTENT_SETTLE_SECONDS must be between 5 and 3600');
  return config;
}

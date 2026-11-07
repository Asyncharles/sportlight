/**
 * Tunable behaviour. Defaults live here; the backend overrides them from environment variables and
 * sends the effective values to every client in its `welcome` message, so ops can tune without a
 * client release.
 */

export interface SelectionConfig {
  /** Minimum time an automatically placed feed stays visible before it can be replaced. */
  minDisplayMs: number;
  /** A challenger must out-rank the weakest replaceable side feed by at least this many points… */
  replaceMargin: number;
  /** …continuously for this long. */
  challengeMs: number;
  /** Personal ranking adjustment applied for the viewer's own up/down votes. */
  voteBoost: { up: number; down: number };
}

export interface HighlightConfig {
  /** A moment starts when intensity reaches this score… */
  enterThreshold: number;
  /** …and ends when it falls below this one (hysteresis avoids flapping). */
  exitThreshold: number;
  /** Seconds of build-up kept before the moment starts. */
  preRollSec: number;
  /** Seconds kept after the moment ends. */
  postRollSec: number;
  minClipSec: number;
  maxClipSec: number;
  /** Moments on the same run closer than this are merged into one highlight. */
  mergeGapSec: number;
  /**
   * Treat highlights cut from overlapping ranges of the same media file as duplicates (the demo
   * media loops, so the "same moment" can recur). Keeps the higher-peaked one.
   */
  dedupeByMedia: boolean;
  /** IANA timezone that defines "today". */
  timezone: string;
  /** Upper bound on highlights retained per day. */
  maxPerDay: number;
}

export interface ClientConfig {
  selection: SelectionConfig;
  highlights: Pick<HighlightConfig, 'timezone' | 'enterThreshold'>;
  /** Intensity older than this is considered stale. */
  staleAfterMs: number;
}

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
  minDisplayMs: 20_000,
  replaceMargin: 10,
  challengeMs: 3_000,
  voteBoost: { up: 8, down: -15 },
};

export const DEFAULT_HIGHLIGHT_CONFIG: HighlightConfig = {
  enterThreshold: 78,
  exitThreshold: 68,
  preRollSec: 6,
  postRollSec: 3,
  minClipSec: 8,
  maxClipSec: 24,
  mergeGapSec: 12,
  dedupeByMedia: true,
  timezone: 'Europe/London',
  maxPerDay: 250,
};

export const DEFAULT_STALE_AFTER_MS = 5_000;

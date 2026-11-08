/**
 * Core domain model shared by the publisher, backend and web client.
 *
 * The catalogue is deliberately hierarchical (sport → competition → team) so preferences can grow
 * from "sports I follow" to leagues, competitions and teams without changing the wire contracts.
 */

export type SportId = string;
export type CompetitionId = string;
export type TeamId = string;
export type FeedId = string;
export type RunId = string;

/** Name of the Lucide icon used for a sport. Mapped to components in the web client. */
export type SportIconName =
  | 'goal'
  | 'volleyball'
  | 'ball-wave'
  | 'flag'
  | 'hockey-stick'
  | 'bike'
  | 'rugby-ball'
  | 'chess-knight'
  | 'gamepad-2'
  | 'footprints'
  | 'dumbbell';

export interface Sport {
  id: SportId;
  name: string;
  icon: SportIconName;
}

export interface Competition {
  id: CompetitionId;
  sportId: SportId;
  name: string;
}

export interface Team {
  id: TeamId;
  sportId: SportId;
  name: string;
  shortName?: string;
}

/** Something a viewer follows. Only `sport` is editable in the prototype UI. */
export type FollowKind = 'sport' | 'competition' | 'team';
export interface Follow {
  kind: FollowKind;
  id: string;
}

export interface EventInfo {
  /** Display title, e.g. "France v Germany". */
  title: string;
  /** Secondary line, e.g. competition or stage. */
  subtitle?: string;
  competitionId?: CompetitionId;
  teamIds?: TeamId[];
  venue?: string;
  /** Rights holder / channel carrying the stream, e.g. Sky Sports · Sky Sports Football. */
  broadcaster?: Broadcaster;
}

export interface Broadcaster {
  /** Network, e.g. "Sky Sports". */
  name: string;
  /** Channel, e.g. "Sky Sports Football". */
  channel?: string;
}

/**
 * A playable media source. `looping-mp4` is the prototype's simulated-live transport: a looping
 * progressive MP4 where every viewer derives the same live position from the run start time.
 * Additional kinds (e.g. `hls`) can be added to this union without touching the rest of the model.
 */
export type MediaSource = LoopingMp4Source;

export interface ThumbnailStrip {
  /** URL template containing `{index}`; frame `index` is taken at `index * intervalSec` media seconds. */
  template: string;
  intervalSec: number;
  count: number;
}

export interface MediaCredit {
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
}

export interface LoopingMp4Source {
  kind: 'looping-mp4';
  /** Absolute URL, or origin-relative path (resolved against the client's media base). */
  url: string;
  durationSec: number;
  /** Media position (seconds) that plays at stream time 0 of the run. */
  mediaOffsetSec: number;
  hasAudio: boolean;
  posterUrl?: string;
  thumbnails?: ThumbnailStrip;
  /** Attribution travels with the footage into saved highlights and exported descriptions. */
  credits?: MediaCredit[];
  attributionNotice?: string;
}

export type FeedStatus = 'live' | 'unavailable' | 'ended';
export type EndReason = 'completed' | 'cancelled' | 'failed' | 'timeout';
export type UnavailableReason = 'provider' | 'silent';

export interface IntensityReading {
  /** 0–100. */
  score: number;
  /** Seconds since the run started — the stream/media timeline position the score describes. */
  streamTime: number;
  /** Provider timestamp (ISO 8601). */
  at: string;
}

/** Authoritative, per-feed state as held by the backend and mirrored to clients. */
export interface FeedState {
  id: FeedId;
  runId: RunId;
  provider: string;
  sportId: SportId;
  event: EventInfo;
  source: MediaSource;
  status: FeedStatus;
  unavailableReason?: UnavailableReason;
  /** Wall-clock start of the current run (ISO). Stream time 0. */
  startedAt: string;
  endedAt?: string;
  endReason?: EndReason;
  intensity: IntensityReading | null;
  /** True when no intensity update has been received recently. */
  intensityStale: boolean;
  /** Ordering cursor: last applied sequence number for this run. */
  seq: number;
  /** Aggregate viewer votes for the current run. Separate from the provider intensity. */
  votes: { up: number; down: number };
}

export type VoteValue = -1 | 0 | 1;

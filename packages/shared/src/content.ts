import type { Highlight } from './highlights.js';

/**
 * A Short's single lifecycle. Status is the only source of truth for where a Short is.
 *
 *   pending → rendering → ready ──(operator publishes)──→ scheduled → uploading → processing → published
 *                           ↑  └──(operator discards)──→ discarded ──(restore)──┘
 *                           └────────(unschedule)──── scheduled
 *
 * `failed` holds anything that needs the operator (render, upload or YouTube problems); `message` says why.
 * Nothing is uploaded unless the operator moved it from `ready` to `scheduled`.
 */
export type ContentStatus =
  | 'pending'
  | 'rendering'
  | 'ready'
  | 'scheduled'
  | 'uploading'
  | 'processing'
  | 'published'
  | 'failed'
  | 'discarded';

/** Operator actions on Shorts. Each applies only to Shorts in the states listed in CONTENT_ACTIONS. */
export type ContentAction = 'publish' | 'unschedule' | 'discard' | 'restore' | 'retry';

/** Which states each action accepts. Shared so the dashboard only offers actions the backend will take. */
export const CONTENT_ACTIONS: Record<ContentAction, readonly ContentStatus[]> = {
  publish: ['ready'],
  unschedule: ['scheduled'],
  discard: ['pending', 'ready', 'scheduled', 'failed'],
  restore: ['discarded'],
  retry: ['failed'],
};

export interface ContentJob {
  id: string;
  highlight: Highlight;
  status: ContentStatus;
  /** The channel this Short was scheduled for; set when the operator publishes it. */
  channelId?: string;
  createdAt: number;
  updatedAt: number;
  /** Earliest time the worker may next act on this Short. */
  readyAt: number;
  attempts: number;
  /** Why the Short is in its current state (failure, discard reason, quota wait…). */
  message?: string;
  /** A rendered video exists and can be previewed. */
  rendered: boolean;
  videoId?: string;
  visibility?: string;
}
export interface ContentSettings {
  enabled: boolean;
  minPeak: number;
  /** Maximum uploads per day; 0 means no cap. */
  dailyLimit: number;
  intervalMinutes: number;
}
export interface ContentOverview {
  configured: boolean;
  authenticated: boolean;
  missing: string[];
  user?: { email: string; name: string };
  csrf?: string;
  channel?: { id: string; title: string };
  settings?: ContentSettings;
  jobs?: ContentJob[];
  timezone?: string;
  connectionError?: string;
  schedule?: ContentSchedule;
}
/** What the publishing worker is doing or waiting for right now. */
export interface ContentSchedule {
  state: 'working' | 'waiting' | 'idle' | 'paused' | 'blocked';
  /** working: the active job; waiting: the scheduled job that uploads next. */
  jobId?: string;
  /** Why the next upload has not started yet. */
  reason?: 'interval' | 'retry' | 'quota' | 'daily_limit';
  /** When the next upload can start (waiting only). */
  nextAt?: number;
}

import type { Highlight } from './highlights.js';

export type ContentStatus =
  'queued' | 'rendering' | 'uploading' | 'processing' | 'published' | 'failed' | 'attention' | 'skipped';
export interface ContentJob {
  id: string;
  highlight: Highlight;
  channelId: string;
  status: ContentStatus;
  createdAt: number;
  updatedAt: number;
  readyAt: number;
  attempts: number;
  message?: string;
  videoId?: string;
  visibility?: string;
  rendered: boolean;
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
  /** working: the active job; waiting: the job that will start next. */
  jobId?: string;
  /** Why the next job has not started yet. */
  reason?: 'interval' | 'settling' | 'quota' | 'daily_limit' | 'caption';
  /** When the next job can start (waiting only). */
  nextAt?: number;
}

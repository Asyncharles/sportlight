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
}

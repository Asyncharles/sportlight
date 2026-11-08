import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentJob, ContentSettings, ContentStatus, Highlight } from '@sportlight/shared';

export interface Job extends ContentJob {
  uploadSession?: string;
  uploadStartedAt?: number;
  nextPollAt?: number;
}
export interface Connection {
  id: string;
  title: string;
  email: string;
  name: string;
  refreshToken: string;
}
/** A signed-in dashboard session. Persisted so backend restarts don't sign the operator out. */
export interface StoredSession {
  /** SHA-256 of the cookie value; the raw value is never stored. */
  id: string;
  email: string;
  name: string;
  csrf: string;
  expires: number;
}
interface State {
  version: 1;
  /**
   * Job lifecycle revision. 2 introduced the review library (nothing uploads without approval);
   * 3 folded the `approved` flag into status and merged duplicate states.
   */
  jobsRevision?: number;
  sessions?: StoredSession[];
  /**
   * Settings schema revision; 2 introduced `dailyLimit: 0` meaning no daily cap,
   * 3 introduced `intervalMinutes: 0` meaning no spacing between uploads.
   */
  settingsRevision?: number;
  settings: ContentSettings;
  connection?: Connection;
  connectionError?: string;
  jobs: Job[];
  seen: string[];
}

/** Single backend instance, serialized atomic snapshots on the persistent volume. */
export class ContentStore {
  state: State = {
    version: 1,
    settings: { enabled: true, minPeak: 90, dailyLimit: 0, intervalMinutes: 0 },
    settingsRevision: 3,
    jobsRevision: 3,
    sessions: [],
    jobs: [],
    seen: [],
  };
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly dir: string) {}
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')) as State;
      if (this.state.version !== 1 || !Array.isArray(this.state.jobs)) throw new Error('Invalid content state');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if ((this.state.settingsRevision ?? 1) < 2) {
      // The old built-in default of 5/day was a cap nobody chose; lift it. Explicit other values stay.
      if (this.state.settings.dailyLimit === 5) this.state.settings.dailyLimit = 0;
      this.state.settingsRevision = 2;
    }
    if ((this.state.settingsRevision ?? 1) < 3) {
      // Likewise the old 15-minute spacing default; lift it so approved Shorts publish back to back.
      if (this.state.settings.intervalMinutes === 15) this.state.settings.intervalMinutes = 0;
      this.state.settingsRevision = 3;
    }
    if ((this.state.jobsRevision ?? 1) < 3) {
      for (const job of this.state.jobs) migrateJob(job as LegacyJob, this.state.jobsRevision ?? 1);
      this.state.jobsRevision = 3;
    }
    // Repair stragglers: a worker still running older code can write legacy statuses after the revision bump.
    for (const job of this.state.jobs as LegacyJob[]) {
      if (job.status in LEGACY_STATUSES || 'approved' in job) migrateJob(job, 3);
    }
    this.state.sessions = (this.state.sessions ?? []).filter((s) => s.expires > Date.now());
    for (const job of this.state.jobs) {
      if (job.status === 'rendering') job.status = 'pending';
      // Preserve uploading jobs and their resumable URL; never create another upload after an ambiguous result.
    }
    await this.save();
  }
  save() {
    const snapshot = JSON.stringify(this.state);
    const operation = this.pending.then(async () => {
      const file = join(this.dir, 'state.json');
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

const LEGACY_STATUSES = { queued: true, approved: true, attention: true, skipped: true };
type LegacyJob =Omit<Job, 'status'> & { status: ContentStatus | 'queued' | 'approved' | 'attention' | 'skipped'; approved?: boolean };
/**
 * Maps revision 1/2 jobs onto the single-status lifecycle. Anything with an upload in flight keeps it;
 * an approval for a Short that still needed (re-)rendering is dropped so the operator reviews the final video.
 */
function migrateJob(job: LegacyJob, revision: number) {
  const inFlight = Boolean(job.uploadSession || job.videoId);
  // Revision 1 had no library: everything queued was implicitly approved.
  const approved = revision < 2 ? inFlight : Boolean(job.approved);
  const map: Record<string, ContentStatus> = {
    queued: job.rendered && !approved ? 'ready' : 'pending',
    approved: 'scheduled',
    attention: 'failed',
    skipped: 'discarded',
  };
  let status = map[job.status] ?? (job.status as ContentStatus);
  if (status === 'ready' && approved && job.channelId) status = 'scheduled';
  if (status === 'scheduled' && !job.rendered) status = 'pending';
  job.status = status;
  delete job.approved;
}

export function seal(value: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
export function unseal(value: string, key: string): string {
  const buffer = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), buffer.subarray(0, 12));
  cipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
}
export function overlaps(a: Highlight, b: Highlight) {
  if (a.source.url !== b.source.url) return false;
  const length = Math.min(a.clip.mediaEnd - a.clip.mediaStart, b.clip.mediaEnd - b.clip.mediaStart);
  return (
    length > 0 &&
    (Math.min(a.clip.mediaEnd, b.clip.mediaEnd) - Math.max(a.clip.mediaStart, b.clip.mediaStart)) / length >= 0.5
  );
}
export function publicJob(job: Job): ContentJob {
  const { uploadSession: _session, uploadStartedAt: _started, nextPollAt: _poll, ...safe } = job;
  return safe;
}

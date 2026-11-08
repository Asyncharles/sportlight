import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentJob, ContentSettings, Highlight } from '@sportlight/shared';

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
interface State {
  version: 1;
  /** Settings schema revision; 2 introduced `dailyLimit: 0` meaning no daily cap. */
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
    settings: { enabled: true, minPeak: 90, dailyLimit: 0, intervalMinutes: 15 },
    settingsRevision: 2,
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
    for (const job of this.state.jobs) {
      if (job.status === 'rendering') job.status = 'queued';
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

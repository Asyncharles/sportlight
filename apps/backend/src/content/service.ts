import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { dayKey, type ContentOverview, type Highlight } from '@sportlight/shared';
import { z } from 'zod';
import type { BackendConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { beginUpload, GoogleError, googleFetch, resumeUpload, SCOPES, tokenRequest } from './google.js';
import { renderClip } from './renderer.js';
import { ContentStore, overlaps, publicJob, seal, unseal, type Job } from './store.js';

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    minPeak: z.number().int().min(0).max(100),
    dailyLimit: z.number().int().min(1).max(100),
    intervalMinutes: z.number().int().min(0).max(1440),
  })
  .strict();
interface Session {
  email: string;
  name: string;
  csrf: string;
  expires: number;
}
interface Login {
  verifier: string;
  expires: number;
}
const random = () => randomBytes(32).toString('base64url');
const fingerprint = (h: Highlight) => JSON.stringify([h.source, h.clip, h.peak]);

export class ContentService {
  readonly store: ContentStore;
  private sessions = new Map<string, Session>();
  private logins = new Map<string, Login>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private persistenceFailed = false;
  private readonly options: BackendConfig['content'];
  constructor(
    private config: BackendConfig,
    private highlights: () => Highlight[],
    private log: Logger,
  ) {
    this.options = config.content;
    this.store = new ContentStore(join(config.dataDir, 'content'));
  }
  async init() {
    await this.store.init();
  }
  start() {
    this.timer = setInterval(() => {
      if (this.running || this.stopped || this.persistenceFailed) return;
      this.running = this.tick()
        .catch(() => {
          this.log.error(
            'content worker stopped: persistence or unexpected worker failure; restart after checking storage',
          );
          this.persistenceFailed = true;
        })
        .finally(() => {
          this.running = undefined;
        });
    }, 5000);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
    await this.store.save();
  }
  private missing() {
    return [
      !this.options.clientId && 'GOOGLE_CLIENT_ID',
      !this.options.clientSecret && 'GOOGLE_CLIENT_SECRET',
      !this.options.encryptionKey && 'CONTENT_ENCRYPTION_KEY',
      !this.options.allowedEmails.length && 'CONTENT_ALLOWED_EMAILS',
    ].filter((v): v is string => Boolean(v));
  }
  private cookie(req: IncomingMessage, name: string) {
    return req.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${name}=`))
      ?.slice(name.length + 1);
  }
  private setCookie(res: ServerResponse, name: string, value: string, seconds: number) {
    res.setHeader(
      'Set-Cookie',
      `${name}=${value}; Path=/api/content; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.options.appUrl.startsWith('https:') ? '; Secure' : ''}`,
    );
  }
  private session(req: IncomingMessage) {
    const id = this.cookie(req, 'sl_content');
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || session.expires < Date.now()) {
      if (id) this.sessions.delete(id);
      return undefined;
    }
    return session;
  }
  private overview(session?: Session): ContentOverview {
    const missing = this.missing();
    if (!session) return { configured: !missing.length, authenticated: false, missing };
    const state = this.store.state;
    return {
      configured: !missing.length,
      authenticated: true,
      missing,
      user: { email: session.email, name: session.name },
      csrf: session.csrf,
      channel: state.connection ? { id: state.connection.id, title: state.connection.title } : undefined,
      settings: state.settings,
      jobs: state.jobs.slice(-500).reverse().map(publicJob),
      timezone: this.config.highlights.timezone,
      connectionError: this.persistenceFailed
        ? 'Storage failed. Publishing stopped; check server storage and restart.'
        : state.connectionError,
    };
  }
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/api/content' && !url.pathname.startsWith('/api/content/')) return false;
    // Content uses same-origin cookies; never inherit the public feed API's CORS policy.
    res.removeHeader('Access-Control-Allow-Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const path = url.pathname.slice('/api/content'.length);
    const session = this.session(req);
    try {
      if (req.method === 'GET' && path === '/session') {
        json(res, 200, this.overview(session));
        return true;
      }
      if (req.method === 'GET' && path === '/auth/start') {
        if (this.missing().length) {
          json(res, 503, { error: 'Google sign-in is not configured.' });
          return true;
        }
        for (const [key, login] of this.logins) if (login.expires < Date.now()) this.logins.delete(key);
        if (this.logins.size >= 1000) {
          json(res, 429, { error: 'Too many sign-in attempts. Try again shortly.' });
          return true;
        }
        const state = random();
        const verifier = random();
        this.logins.set(state, { verifier, expires: Date.now() + 10 * 60_000 });
        this.setCookie(res, 'sl_oauth', state, 600);
        const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authorization.search = new URLSearchParams({
          client_id: this.options.clientId,
          redirect_uri: this.redirectUri(),
          response_type: 'code',
          scope: SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        }).toString();
        redirect(res, authorization.href);
        return true;
      }
      if (req.method === 'GET' && path === '/auth/callback') {
        await this.callback(req, res, url);
        return true;
      }
      if (!session) {
        json(res, 401, { error: 'Sign in with your authorized Google account.' });
        return true;
      }
      if (req.method === 'POST') {
        if (
          req.headers.origin !== new URL(this.options.appUrl).origin ||
          req.headers['x-csrf-token'] !== session.csrf
        ) {
          json(res, 403, { error: 'Invalid request origin or session. Refresh and try again.' });
          return true;
        }
        if (this.persistenceFailed) {
          json(res, 503, { error: 'Publishing storage is unavailable.' });
          return true;
        }
        if (path === '/settings') {
          const parsed = settingsSchema.safeParse(await readJson(req));
          if (!parsed.success) {
            json(res, 400, { error: 'Invalid automation settings.' });
            return true;
          }
          this.store.state.settings = parsed.data;
          await this.store.save();
          json(res, 200, this.overview(session));
          return true;
        }
        if (path === '/logout') {
          this.sessions.delete(this.cookie(req, 'sl_content')!);
          this.setCookie(res, 'sl_content', '', 0);
          json(res, 200, { ok: true });
          return true;
        }
        if (path === '/disconnect') {
          this.store.state.settings.enabled = false;
          delete this.store.state.connection;
          delete this.store.state.connectionError;
          await this.store.save();
          json(res, 200, this.overview(session));
          return true;
        }
        const action = path.match(/^\/jobs\/([a-f0-9-]+)\/(retry|skip)$/);
        if (action) {
          const job = this.store.state.jobs.find((j) => j.id === action[1]);
          if (!job || job.channelId !== this.store.state.connection?.id) {
            json(res, 404, { error: 'Job not found for this channel.' });
            return true;
          }
          if (action[2] === 'skip' && ['queued', 'failed'].includes(job.status) && !job.uploadSession) {
            job.status = 'skipped';
            job.message = 'Skipped by operator.';
          } else if (action[2] === 'retry' && ['failed', 'attention'].includes(job.status) && !job.videoId) {
            // With a session, retry only probes/resumes it. It never starts a replacement upload.
            job.status = job.uploadSession ? 'uploading' : 'queued';
            job.attempts = 0;
            job.readyAt = Date.now();
            delete job.message;
          } else {
            json(res, 409, { error: 'This job cannot be changed in its current state.' });
            return true;
          }
          job.updatedAt = Date.now();
          await this.store.save();
          json(res, 200, this.overview(session));
          return true;
        }
      }
      const asset = path.match(/^\/jobs\/([a-f0-9-]+)\/video$/);
      if (req.method === 'GET' && asset) {
        const job = this.store.state.jobs.find((j) => j.id === asset[1]);
        if (!job?.rendered) {
          json(res, 404, { error: 'Render not ready.' });
          return true;
        }
        await serveVideo(req, res, this.file(job));
        return true;
      }
      json(res, 404, { error: 'Not found.' });
      return true;
    } catch (error) {
      // OAuth codes, refresh tokens, upload URLs and provider payloads are never logged.
      this.log.warn('content request failed', {
        path,
        type: error instanceof GoogleError ? error.reason : 'request_failed',
      });
      if (path === '/auth/callback') redirect(res, `${this.options.appUrl}/dashboard?auth=failed`);
      else if (!res.headersSent) json(res, 500, { error: 'Request failed. Check configuration and try again.' });
      else res.destroy();
      return true;
    }
  }
  private redirectUri() {
    return `${this.options.appUrl}/api/content/auth/callback`;
  }
  private async callback(req: IncomingMessage, res: ServerResponse, url: URL) {
    const state = url.searchParams.get('state') || '';
    const login = this.logins.get(state);
    this.logins.delete(state);
    if (
      !login ||
      login.expires < Date.now() ||
      this.cookie(req, 'sl_oauth') !== state ||
      !url.searchParams.get('code')
    ) {
      throw new Error('Invalid OAuth callback');
    }
    const tokens = await tokenRequest({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code: url.searchParams.get('code')!,
      code_verifier: login.verifier,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(),
    });
    if (
      !tokens.scope ||
      !SCOPES.filter((s) => s.includes('youtube')).every((s) => tokens.scope!.split(' ').includes(s))
    ) {
      throw new Error('YouTube permissions were not granted');
    }
    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    const identity = (await (
      await googleFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers })
    ).json()) as { email?: string; email_verified?: boolean; name?: string };
    const email = identity.email?.toLowerCase();
    if (!email || identity.email_verified !== true || !this.options.allowedEmails.includes(email))
      throw new Error('Account is not an authorized operator');
    const channels = (await (
      await googleFetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers })
    ).json()) as { items?: { id: string; snippet: { title: string } }[] };
    const channel = channels.items?.[0];
    if (!channel) throw new Error('Create a YouTube channel before connecting');
    const previous = this.store.state.connection;
    if (previous && previous.id !== channel.id)
      throw new Error('Disconnect the current channel before changing channels');
    const refreshToken = tokens.refresh_token
      ? seal(tokens.refresh_token, this.options.encryptionKey)
      : previous?.email === email && previous.id === channel.id
        ? previous.refreshToken
        : undefined;
    if (!refreshToken) throw new Error('Offline access was not granted');
    if (!previous) this.store.state.seen = this.highlights().map((h) => h.id);
    this.store.state.connection = {
      id: channel.id,
      title: channel.snippet.title,
      email,
      name: identity.name || email,
      refreshToken,
    };
    delete this.store.state.connectionError;
    await this.store.save();
    for (const [key, value] of this.sessions) if (value.expires < Date.now()) this.sessions.delete(key);
    const id = random();
    this.sessions.set(id, { email, name: identity.name || email, csrf: random(), expires: Date.now() + 12 * 3600_000 });
    this.setCookie(res, 'sl_content', id, 12 * 3600);
    redirect(res, `${this.options.appUrl}/dashboard`);
  }
  private async accessToken() {
    const connection = this.store.state.connection;
    if (!connection) throw new Error('Connect a channel to publish');
    try {
      const tokens = await tokenRequest({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: unseal(connection.refreshToken, this.options.encryptionKey),
      });
      return tokens.access_token;
    } catch (error) {
      if (error instanceof GoogleError && [400, 401].includes(error.status)) {
        this.store.state.connectionError = 'Google access expired or was revoked. Reconnect your account to continue.';
        await this.store.save();
      }
      throw error;
    }
  }
  private file(job: Job) {
    return join(this.store.dir, job.id, 'short.mp4');
  }
  private async discover(now: number) {
    const state = this.store.state;
    if (!state.connection) return;
    const highlights = this.highlights();
    const current = new Map(highlights.map((h) => [h.id, h]));
    const seen = new Set(state.seen);
    let changed = false;
    for (const job of state.jobs) {
      if (job.status !== 'queued' || job.uploadSession || job.channelId !== state.connection.id) continue;
      const h = current.get(job.highlight.id);
      if (!h) {
        job.status = 'skipped';
        job.message = 'Highlight was merged or removed.';
        changed = true;
      } else if (fingerprint(job.highlight) !== fingerprint(h)) {
        job.highlight = structuredClone(h);
        job.rendered = false;
        job.readyAt = now + this.options.settleSeconds * 1000;
        changed = true;
      } else if (JSON.stringify(job.highlight.caption) !== JSON.stringify(h.caption)) {
        job.highlight = structuredClone(h);
        changed = true;
      }
    }
    for (const h of highlights) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      changed = true;
      const duplicate = state.jobs.some(
        (j) => j.channelId === state.connection!.id && j.status !== 'skipped' && overlaps(j.highlight, h),
      );
      state.jobs.push({
        id: randomUUID(),
        highlight: structuredClone(h),
        channelId: state.connection.id,
        status: duplicate || h.peak.score < state.settings.minPeak ? 'skipped' : 'queued',
        message: duplicate
          ? 'Repeated footage already queued or uploaded.'
          : h.peak.score < state.settings.minPeak
            ? 'Below the minimum peak intensity.'
            : undefined,
        createdAt: now,
        updatedAt: now,
        readyAt: Math.max(now + this.options.settleSeconds * 1000, Date.parse(h.startedAt) + h.clip.durationSec * 1000),
        attempts: 0,
        rendered: false,
      });
    }
    // Highlight IDs outside the retained source window no longer need a separate seen entry.
    state.seen = [...seen].filter((id) => current.has(id));
    if (changed) await this.store.save();
  }
  /** One serialized worker; all durable transitions precede external side effects. */
  async tick(now = Date.now()) {
    if (this.stopped || this.missing().length) return;
    await this.discover(now);
    const state = this.store.state;
    const connection = state.connection;
    if (!connection || state.connectionError) return;
    const processing = state.jobs.find(
      (j) => j.channelId === connection.id && j.status === 'processing' && (j.nextPollAt ?? 0) <= now,
    );
    if (processing) {
      await this.poll(processing, now);
      return;
    }
    if (!state.settings.enabled) return;
    const jobs = state.jobs.filter((j) => j.channelId === connection.id);
    const job = jobs.find((j) => ['queued', 'uploading'].includes(j.status) && j.readyAt <= now);
    if (!job) return;
    if (!job.uploadSession) {
      if (now - job.createdAt > 24 * 3600_000) {
        job.status = 'skipped';
        job.message = 'Expired after 24 hours in the queue.';
        await this.store.save();
        return;
      }
      if (job.highlight.peak.score < state.settings.minPeak) {
        job.status = 'skipped';
        job.message = 'Below the minimum peak intensity.';
        await this.store.save();
        return;
      }
      const started = jobs.filter((j) => j.uploadStartedAt !== undefined);
      const today = dayKey(now, this.config.highlights.timezone);
      if (
        started.filter((j) => dayKey(j.uploadStartedAt!, this.config.highlights.timezone) === today).length >=
        state.settings.dailyLimit
      )
        return;
      if (started.some((j) => now - j.uploadStartedAt! < state.settings.intervalMinutes * 60_000)) return;
    }
    try {
      if (!job.rendered) {
        job.status = 'rendering';
        job.updatedAt = now;
        await this.store.save();
        await renderClip(
          job.highlight,
          join(this.store.dir, job.id),
          this.options.mediaBase,
          this.config.captions.mediaPublicPrefix,
          this.options.ffmpegPath,
        );
        job.rendered = true;
        job.status = 'queued';
        await this.store.save();
      }
      // A highlight can be merged while FFmpeg is working. Never publish superseded footage.
      if (!job.uploadSession) {
        const latest = this.highlights().find((h) => h.id === job.highlight.id);
        if (!latest || fingerprint(latest) !== fingerprint(job.highlight)) {
          job.status = latest ? 'queued' : 'skipped';
          job.rendered = false;
          if (latest) job.highlight = structuredClone(latest);
          job.readyAt = Date.now() + this.options.settleSeconds * 1000;
          job.message = latest
            ? 'Highlight changed; preparing its latest revision.'
            : 'Highlight was merged or removed.';
          await this.store.save();
          return;
        }
        if (job.highlight.peak.score < state.settings.minPeak) {
          job.status = 'skipped';
          job.message = 'Below the minimum peak intensity.';
          await this.store.save();
          return;
        }
      }
      // Pause/disconnect can arrive while FFmpeg runs. Stop before issuing an upload.
      if (!state.settings.enabled || state.connection !== connection || this.stopped) return;
      const token = await this.accessToken();
      if (!job.uploadSession) {
        // Persist the reservation before beginning a resumable session; count ambiguous starts conservatively.
        job.uploadStartedAt = Date.now();
        job.status = 'uploading';
        await this.store.save();
        const session = await beginUpload(token, this.file(job), job.highlight);
        job.uploadSession = seal(session, this.options.encryptionKey);
        await this.store.save();
      }
      if (!state.settings.enabled || state.connection !== connection || this.stopped) return;
      job.status = 'uploading';
      await this.store.save();
      const video = await resumeUpload(token, unseal(job.uploadSession, this.options.encryptionKey), this.file(job));
      job.videoId = video.id;
      job.visibility = video.status?.privacyStatus;
      job.status = 'processing';
      job.nextPollAt = Date.now() + 15_000;
      job.attempts = 0;
      delete job.message;
    } catch (error) {
      job.attempts++;
      const expired = error instanceof GoogleError && [404, 410].includes(error.status) && job.uploadSession;
      const retryable = !(error instanceof GoogleError) || error.status >= 500 || error.status === 429;
      job.status = expired
        ? 'attention'
        : retryable && job.attempts < 5
          ? job.uploadSession
            ? 'uploading'
            : 'queued'
          : 'failed';
      job.readyAt = Date.now() + Math.min(3600_000, 30_000 * 2 ** job.attempts);
      job.message = expired
        ? 'Upload session expired. Check YouTube Studio before taking further action; no replacement will be uploaded automatically.'
        : error instanceof GoogleError
          ? error.message
          : 'Rendering or upload interrupted. Retrying safely; check media availability if this persists.';
    }
    job.updatedAt = Date.now();
    await this.store.save();
  }
  private async poll(job: Job, now: number) {
    try {
      const token = await this.accessToken();
      const response = await googleFetch(
        `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(job.videoId!)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await response.json()) as {
        items?: {
          status: { privacyStatus: string; uploadStatus: string; rejectionReason?: string };
          processingDetails?: { processingStatus: string };
        }[];
      };
      const video = data.items?.[0];
      if (!video) throw new Error('Video not yet visible');
      job.visibility = video.status.privacyStatus;
      if (
        ['failed', 'rejected', 'deleted'].includes(video.status.uploadStatus) ||
        ['failed', 'terminated'].includes(video.processingDetails?.processingStatus ?? '')
      ) {
        job.status = 'attention';
        job.message = `YouTube could not publish this video (${video.status.rejectionReason || video.status.uploadStatus}). Check YouTube Studio.`;
      } else if (
        video.status.uploadStatus === 'processed' ||
        video.processingDetails?.processingStatus === 'succeeded'
      ) {
        job.status = job.visibility === 'public' ? 'published' : 'attention';
        job.message =
          job.visibility === 'public'
            ? undefined
            : `YouTube reports ${job.visibility} visibility. Check channel or API restrictions in YouTube Studio.`;
      } else if (now - (job.uploadStartedAt ?? job.createdAt) > 24 * 3600_000) {
        job.status = 'attention';
        job.message = 'YouTube processing has not completed after 24 hours. Check YouTube Studio.';
      }
      job.attempts = 0;
    } catch {
      job.attempts++;
      if (job.attempts >= 10) {
        job.status = 'attention';
        job.message =
          'Could not confirm YouTube processing. Check YouTube Studio; this video will not be uploaded again.';
      }
    }
    job.nextPollAt = now + Math.min(3600_000, 30_000 * 2 ** Math.min(job.attempts, 6));
    job.updatedAt = now;
    await this.store.save();
  }
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { Location: location });
  res.end();
}
async function readJson(req: IncomingMessage) {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 8192) throw new Error('Body too large');
  }
  return JSON.parse(body) as unknown;
}
async function serveVideo(req: IncomingMessage, res: ServerResponse, file: string) {
  const { size } = await stat(file);
  let start = 0;
  let end = size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : end;
    if (!Number.isSafeInteger(start) || start < 0 || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.writeHead(req.headers.range ? 206 : 200, {
    'Content-Type': 'video/mp4',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  });
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

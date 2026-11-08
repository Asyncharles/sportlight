import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Pause, Play, Settings2 } from 'lucide-react';
import type {
  ContentJob,
  ContentOverview as ContentData,
  ContentSchedule,
  ContentSettings,
  ContentStatus,
} from '@sportlight/shared';
import { apiUrl } from '../../lib/env';
import { Dialog } from './Dialog';
import styles from './Admin.module.scss';

const POLL_MS = 5000;
const RECENT = 10;
const UP_NEXT = 5;

const labels: Record<ContentStatus, string> = {
  queued: 'Queued',
  rendering: 'Rendering',
  uploading: 'Uploading',
  processing: 'YouTube processing',
  published: 'Published',
  failed: 'Failed',
  attention: 'Needs attention',
  skipped: 'Skipped',
};
const tones: Record<ContentStatus, 'ok' | 'warn' | 'bad' | 'off'> = {
  queued: 'off',
  rendering: 'warn',
  uploading: 'warn',
  processing: 'warn',
  published: 'ok',
  failed: 'bad',
  attention: 'bad',
  skipped: 'off',
};
const needsAttention = (job: ContentJob) => ['failed', 'attention'].includes(job.status);

/** YouTube Shorts publishing panel: connection, totals and the latest clips. */
export function ContentOverview() {
  const [data, setData] = useState<ContentData>();
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/content/session'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      setData((await res.json()) as ContentData);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function mutate(path: string, body = {}) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/content${path}`), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data?.csrf ?? '' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setBusy(false);
    }
  }

  const jobs = data?.jobs ?? [];
  const disabled = busy || offline;
  const authFailed = new URLSearchParams(location.search).get('auth') === 'failed';
  const connected = Boolean(data?.authenticated && data.channel);
  const active = Boolean(connected && data?.settings?.enabled && !data?.connectionError);

  const attention = jobs.filter(needsAttention).length;
  // jobs arrive newest first; the worker takes the oldest ready job first.
  const current = jobs.find((j) => j.id === data?.schedule?.jobId);
  const upNext = jobs
    .filter((j) => j.status === 'queued' && j.channelId === data?.channel?.id && j.id !== current?.id)
    .reverse();
  const recent = jobs.filter((j) => ['published', 'failed', 'attention'].includes(j.status));
  const skipped = jobs.filter((j) => j.status === 'skipped');

  return (
    <section className={`${styles.panel} ${styles.content}`} aria-labelledby="content-heading">
      <div className={styles.panelHead}>
        <div className={styles.panelTitleBlock}>
          <h2 id="content-heading" className={styles.panelTitle}>
            Publishing
          </h2>
          <span className={styles.panelSub}>
            {offline
              ? 'Service unreachable'
              : !data
                ? 'Loading…'
                : !data.authenticated
                  ? 'YouTube not connected'
                  : data.channel?.title || 'No channel'}
          </span>
        </div>
        {data && (
          <div className={styles.actions}>
            {connected && (
              <span className={`${styles.status} ${styles[`status_${active ? 'ok' : data.connectionError ? 'bad' : 'off'}`]}`}>
                {data.connectionError ? 'Attention' : active ? 'Active' : 'Paused'}
              </span>
            )}
            {connected && data.settings && (
              <button
                type="button"
                className={styles.iconButton}
                disabled={disabled}
                title={data.settings.enabled ? 'Pause automation' : 'Resume automation'}
                aria-label={data.settings.enabled ? 'Pause automation' : 'Resume automation'}
                onClick={() => void mutate('/settings', { ...data.settings!, enabled: !data.settings!.enabled })}
              >
                {data.settings.enabled ? <Pause size={14} /> : <Play size={14} />}
              </button>
            )}
            {data.authenticated && data.settings && (
              <button
                type="button"
                className={styles.iconButton}
                title="Automation settings"
                aria-label="Automation settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className={styles.panelBody}>
        {(error || authFailed || data?.connectionError) && (
          <p className={`${styles.notice} ${styles.err}`} role="alert">
            {error ||
              data?.connectionError ||
              'Google connection failed. Check the allowed account, channel, permissions and OAuth configuration.'}
          </p>
        )}
        {data && !data.configured && (
          <p className={styles.notice}>
            Google sign-in needs setup. Missing: <code className="mono">{data.missing.join(' · ')}</code>
          </p>
        )}
        {data && (!connected || data.connectionError) && data.configured && (
          <div className={styles.connect}>
            <p className={styles.sub}>Connect a YouTube channel to publish big moments as Shorts automatically.</p>
            <a className="sl-button small" href={apiUrl('/api/content/auth/start')}>
              {data.authenticated ? 'Reconnect Google' : 'Connect Google'}
            </a>
          </div>
        )}

        {data?.authenticated && (
          <>
            <div className={styles.miniStats}>
              <Stat label="Queued" value={upNext.length} />
              <Stat label="Published" value={jobs.filter((j) => j.status === 'published').length} />
              <Stat label="Skipped" value={skipped.length} />
              <Stat label="Attention" value={attention} tone={attention ? 'bad' : undefined} />
            </div>

            <NowCard schedule={data.schedule} job={current} now={now} />

            {upNext.length > 0 && (
              <JobSection title="Up next" count={upNext.length}>
                {upNext.slice(0, UP_NEXT).map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
                {upNext.length > UP_NEXT && <li className={styles.more}>+{upNext.length - UP_NEXT} more queued</li>}
              </JobSection>
            )}

            <JobSection title="Recent" count={recent.length}>
              {recent.slice(0, RECENT).map((job) => (
                <JobRow key={job.id} job={job}>
                  {job.videoId ? (
                    <a
                      className={styles.extLink}
                      href={`https://www.youtube.com/shorts/${encodeURIComponent(job.videoId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      YouTube <ArrowUpRight size={12} />
                    </a>
                  ) : needsAttention(job) ? (
                    <button
                      type="button"
                      className={styles.textButton}
                      disabled={disabled}
                      onClick={() => void mutate(`/jobs/${job.id}/retry`)}
                    >
                      Retry
                    </button>
                  ) : null}
                </JobRow>
              ))}
              {recent.length === 0 && <li className={styles.none}>Nothing published yet.</li>}
            </JobSection>

            {skipped.length > 0 && (
              <details className={styles.skipped}>
                <summary>
                  <span>{skipped.length} skipped</span>
                  <span className={styles.listMeta}>
                    {skipReasons(skipped)
                      .map(([reason, n]) => `${n} ${reason}`)
                      .join(' · ')}
                  </span>
                </summary>
                <ul className={styles.list}>
                  {skipped.slice(0, RECENT).map((job) => (
                    <JobRow key={job.id} job={job} note={shortReason(job.message)} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>

      {data?.settings && (
        <Dialog open={settingsOpen} title="Automation settings" onClose={() => setSettingsOpen(false)}>
          <p className={styles.sub}>{data.user?.email}</p>
          <AutomationSettings
            key={JSON.stringify(data.settings)}
            settings={data.settings}
            disabled={disabled}
            connected={Boolean(data.channel)}
            onSave={(s) => mutate('/settings', s)}
            onDisconnect={() => void mutate('/disconnect')}
            onLogout={() => void mutate('/logout')}
          />
        </Dialog>
      )}
    </section>
  );
}

const STAGES = [
  ['rendering', 'Render'],
  ['uploading', 'Upload'],
  ['processing', 'YouTube'],
  ['published', 'Live'],
] as const;

const WAIT_TEXT: Record<NonNullable<ContentSchedule['reason']>, string> = {
  interval: 'Spacing uploads',
  settling: 'Letting the highlight settle',
  caption: 'Waiting for the caption',
  quota: 'YouTube daily quota used',
  daily_limit: 'Daily upload limit reached',
};

function NowCard({ schedule, job, now }: { schedule?: ContentSchedule; job?: ContentJob; now: number }) {
  if (!schedule) return null;
  if (schedule.state === 'working' && job) {
    const stage = STAGES.findIndex(([status]) => status === job.status);
    return (
      <div className={styles.now} aria-live="polite">
        <div className={styles.nowHead}>
          <span className={styles.nowLabel}>Now</span>
          <span className={styles.listMeta}>{labels[job.status]} · {elapsed(now - job.updatedAt)}</span>
        </div>
        <span className={styles.clipTitle}>{title(job)}</span>
        <span className={styles.listMeta}>
          {job.highlight.sportId} · peak {job.highlight.peak.score}
          {job.message ? ` · ${job.message}` : ''}
        </span>
        <ol className={styles.stages}>
          {STAGES.map(([status, label], i) => (
            <li
              key={status}
              className={i < stage ? styles.stageDone : i === stage ? styles.stageActive : undefined}
              aria-current={i === stage ? 'step' : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  const text =
    schedule.state === 'paused'
      ? 'Automation paused.'
      : schedule.state === 'blocked'
        ? 'Publishing is blocked until the channel connection is fixed.'
        : schedule.state === 'idle'
          ? 'Nothing queued. Waiting for the next big moment.'
          : undefined;
  return (
    <div className={styles.now} aria-live="polite">
      <div className={styles.nowHead}>
        <span className={styles.nowLabel}>Now</span>
        {schedule.state === 'waiting' && (
          <span className={styles.listMeta}>
            {schedule.reason ? WAIT_TEXT[schedule.reason] : 'Starting'}
            {schedule.nextAt && schedule.nextAt > now ? ` · next in ${countdown(schedule.nextAt - now)}` : ''}
          </span>
        )}
      </div>
      {text ? (
        <span className={styles.sub}>{text}</span>
      ) : (
        job && (
          <>
            <span className={styles.clipTitle}>Next: {title(job)}</span>
            <span className={styles.listMeta}>
              {job.highlight.sportId} · peak {job.highlight.peak.score}
              {schedule.nextAt && schedule.nextAt > now
                ? ` · starts ${new Date(schedule.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </span>
          </>
        )
      )}
    </div>
  );
}

function JobSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className={styles.jobSection}>
      <h3 className={styles.sectionTitle}>
        {title} <span className={styles.count}>{count}</span>
      </h3>
      <ul className={styles.list}>{children}</ul>
    </section>
  );
}

function JobRow({ job, note, children }: { job: ContentJob; note?: string; children?: ReactNode }) {
  return (
    <li className={styles.listItem}>
      <div className={styles.listMain}>
        <span className={styles.clipTitle}>{title(job)}</span>
        <span className={`${styles.status} ${styles[`status_${tones[job.status]}`]}`}>{labels[job.status]}</span>
      </div>
      <div className={styles.listMain}>
        <span className={styles.listMeta}>
          {job.highlight.sportId} · peak {job.highlight.peak.score} ·{' '}
          {new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {note ? ` · ${note}` : ''}
        </span>
        {children}
      </div>
    </li>
  );
}

const title = (job: ContentJob) => job.highlight.caption?.title || job.highlight.event.title;

function shortReason(message = '') {
  if (/peak/i.test(message)) return 'low peak';
  if (/repeated/i.test(message)) return 'repeat';
  if (/channel/i.test(message)) return 'old channel';
  if (/merged|removed/i.test(message)) return 'merged';
  if (/expired/i.test(message)) return 'expired';
  return message ? 'other' : 'manual';
}

function skipReasons(jobs: ContentJob[]) {
  const counts = new Map<string, number>();
  for (const job of jobs) counts.set(shortReason(job.message), (counts.get(shortReason(job.message)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function countdown(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Ticks once a second so countdowns move between polls. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <div className={styles.miniStat}>
      <div className={`${styles.miniValue} ${tone ? styles[tone] : ''}`}>{value}</div>
      <div className={styles.cardLabel}>{label}</div>
    </div>
  );
}

function AutomationSettings({
  settings,
  disabled,
  connected,
  onSave,
  onDisconnect,
  onLogout,
}: {
  settings: ContentSettings;
  disabled: boolean;
  connected: boolean;
  onSave: (settings: ContentSettings) => Promise<void>;
  onDisconnect: () => void;
  onLogout: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  return (
    <form
      className={styles.settings}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(draft);
      }}
    >
      <div className={styles.settingFields}>
        {(
          [
            ['minPeak', 'Minimum peak intensity', 0, 100],
            ['dailyLimit', 'Daily upload limit (0 = no limit)', 0, 1000],
            ['intervalMinutes', 'Minutes between uploads', 0, 1440],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key}>
            {label}
            <input
              required
              type="number"
              min={min}
              max={max}
              step={1}
              value={draft[key]}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <div className={styles.actions}>
        <button className="sl-button small" disabled={disabled} type="submit">
          Save
        </button>
        {connected && (
          <button type="button" className="sl-button small secondary" disabled={disabled} onClick={onDisconnect}>
            Disconnect channel
          </button>
        )}
        <button type="button" className="sl-button small secondary" disabled={disabled} onClick={onLogout}>
          Sign out
        </button>
      </div>
      <p className={styles.sub}>
        Clips publish publicly with no review step. Signing out keeps automation running; disconnecting pauses it.
      </p>
    </form>
  );
}

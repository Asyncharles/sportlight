import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Pause, Play } from 'lucide-react';
import type { ContentJob, ContentOverview as ContentData, ContentSettings, ContentStatus } from '@sportlight/shared';
import { apiUrl } from '../../lib/env';
import styles from './Admin.module.scss';

const POLL_MS = 5000;
const RECENT = 5;

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
const inProgress = (job: ContentJob) => ['queued', 'rendering', 'uploading', 'processing'].includes(job.status);
const needsAttention = (job: ContentJob) => ['failed', 'attention'].includes(job.status);

/** Brief summary of YouTube Shorts publishing: connection, totals and the latest clips. */
export function ContentOverview() {
  const [data, setData] = useState<ContentData>();
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <section className={styles.section} aria-labelledby="content-heading">
      <div className={styles.sectionHead}>
        <div>
          <h2 id="content-heading" className={styles.sectionTitle}>
            Content
          </h2>
          <p className={styles.sub}>
            {offline
              ? 'Publishing service unreachable'
              : !data
                ? 'Loading…'
                : !data.authenticated
                  ? 'Not connected to YouTube'
                  : `${data.channel?.title || 'No channel'} · ${data.user?.email ?? ''}`}
          </p>
        </div>
        {data && (
          <div className={styles.actions}>
            {connected && (
              <span className={`${styles.status} ${styles[`status_${active ? 'ok' : data.connectionError ? 'bad' : 'off'}`]}`}>
                {data.connectionError ? 'Needs attention' : active ? 'Automation active' : 'Automation paused'}
              </span>
            )}
            {connected && data.settings && (
              <button
                type="button"
                className="sl-button small secondary"
                disabled={disabled}
                onClick={() => void mutate('/settings', { ...data.settings!, enabled: !data.settings!.enabled })}
              >
                {data.settings.enabled ? <Pause size={14} /> : <Play size={14} />}
                {data.settings.enabled ? 'Pause' : 'Resume'}
              </button>
            )}
            {(!connected || data.connectionError) && data.configured && (
              <a className="sl-button small" href={apiUrl('/api/content/auth/start')}>
                {data.authenticated ? 'Reconnect Google' : 'Connect Google'}
              </a>
            )}
          </div>
        )}
      </div>

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

      {data?.authenticated && (
        <>
          <div className={styles.cards}>
            <Stat label="Detected" value={jobs.length} />
            <Stat label="In progress" value={jobs.filter(inProgress).length} />
            <Stat label="Published" value={jobs.filter((j) => j.status === 'published').length} />
            <Stat
              label="Needs attention"
              value={jobs.filter(needsAttention).length}
              tone={jobs.some(needsAttention) ? 'bad' : undefined}
            />
          </div>

          <div className={styles.tableWrap}>
            <h3 className={styles.h2}>Recent clips</h3>
            <table className={`${styles.table} ${styles.static}`}>
              <thead>
                <tr>
                  <th>Clip</th>
                  <th>Status</th>
                  <th className={styles.num}>Peak</th>
                  <th className={styles.num}>Created</th>
                  <th className={styles.num} aria-label="YouTube link" />
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, RECENT).map((job) => (
                  <tr key={job.id}>
                    <td>
                      <div className={styles.feedTitle}>{job.highlight.caption?.title || job.highlight.event.title}</div>
                      <div className={styles.feedId}>
                        {job.highlight.sportId} · {job.highlight.event.title}
                      </div>
                    </td>
                    <td>
                      <span className={`${styles.status} ${styles[`status_${tones[job.status]}`]}`}>
                        {labels[job.status]}
                      </span>
                    </td>
                    <td className={`${styles.num} mono`}>{job.highlight.peak.score}</td>
                    <td className={`${styles.num} mono`}>
                      {new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className={styles.num}>
                      {job.videoId ? (
                        <a
                          className={styles.extLink}
                          href={`https://www.youtube.com/shorts/${encodeURIComponent(job.videoId)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          YouTube <ArrowUpRight size={13} />
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
                    </td>
                  </tr>
                ))}
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan={5} className={styles.none}>
                      Waiting for the next big moment.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data.settings && (
            <details className={styles.config}>
              <summary>Automation settings</summary>
              <AutomationSettings
                key={JSON.stringify(data.settings)}
                settings={data.settings}
                disabled={disabled}
                connected={Boolean(data.channel)}
                onSave={(s) => mutate('/settings', s)}
                onDisconnect={() => void mutate('/disconnect')}
                onLogout={() => void mutate('/logout')}
              />
            </details>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>{label}</div>
      <div className={`${styles.cardValue} ${tone ? styles[tone] : ''}`}>{value}</div>
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
            ['dailyLimit', 'Daily upload limit', 1, 100],
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

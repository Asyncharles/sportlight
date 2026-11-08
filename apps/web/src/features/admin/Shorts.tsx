import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Check, Pause, Play, Settings2 } from 'lucide-react';
import {
  CONTENT_ACTIONS,
  type ContentAction,
  type ContentJob,
  type ContentOverview,
  type ContentSchedule,
  type ContentSettings,
  type ContentStatus,
} from '@sportlight/shared';
import { apiUrl } from '../../lib/env';
import { useDocumentVisible, useNow } from '../../lib/hooks';
import { Dialog } from './Dialog';
import admin from './Admin.module.scss';
import styles from './Shorts.module.scss';

const POLL_MS = 5000;

const LABELS: Record<ContentStatus, string> = {
  pending: 'Waiting to render',
  rendering: 'Rendering',
  ready: 'Ready for review',
  scheduled: 'Scheduled',
  uploading: 'Uploading',
  processing: 'YouTube processing',
  published: 'Published',
  failed: 'Needs action',
  discarded: 'Discarded',
};
const TONES: Record<ContentStatus, 'ok' | 'warn' | 'bad' | 'off'> = {
  pending: 'off',
  rendering: 'warn',
  ready: 'off',
  scheduled: 'ok',
  uploading: 'warn',
  processing: 'warn',
  published: 'ok',
  failed: 'bad',
  discarded: 'off',
};
const ACTION_LABELS: Record<ContentAction, string> = {
  publish: 'Publish',
  unschedule: 'Unschedule',
  discard: 'Discard',
  restore: 'Restore',
  retry: 'Retry',
};

/** Each tab is one slice of the lifecycle, with the actions that make sense there (primary first). */
const TABS = [
  { id: 'review', label: 'Review', statuses: ['ready', 'pending', 'rendering'], actions: ['publish', 'discard'] },
  { id: 'scheduled', label: 'Scheduled', statuses: ['uploading', 'processing', 'scheduled'], actions: ['unschedule'] },
  { id: 'failed', label: 'Needs action', statuses: ['failed'], actions: ['retry', 'discard'] },
  { id: 'published', label: 'Published', statuses: ['published'], actions: [] },
  { id: 'discarded', label: 'Discarded', statuses: ['discarded'], actions: ['restore'] },
] as const satisfies readonly {
  id: string;
  label: string;
  statuses: readonly ContentStatus[];
  actions: readonly ContentAction[];
}[];
type TabId = (typeof TABS)[number]['id'];

/** Mirrors the backend rules so only actions it will accept are offered. */
function canApply(action: ContentAction, job: ContentJob) {
  if (!CONTENT_ACTIONS[action].includes(job.status)) return false;
  if (action === 'restore') return job.rendered;
  if (action !== 'retry' && job.videoId) return false;
  return true;
}

const title = (job: ContentJob) => job.highlight.caption?.title || job.highlight.event.title;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (ms: number) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });

/** YouTube Shorts publishing: review generated Shorts, schedule them, and follow them onto YouTube. */
export function Shorts() {
  const [data, setData] = useState<ContentOverview>();
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string>();
  const [params, setParams] = useSearchParams();
  const visible = useDocumentVisible();
  const now = useNow();

  const tabId: TabId = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as TabId) : 'review';
  const tab = TABS.find((t) => t.id === tabId)!;
  const setTab = (id: TabId) => {
    setSelected(new Set());
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === 'review') next.delete('tab');
        else next.set('tab', id);
        next.delete('auth');
        return next;
      },
      { replace: true },
    );
  };

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/content/session'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      setData((await res.json()) as ContentOverview);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, visible]);

  async function post(path: string, body: unknown = {}) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/content${path}`), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': data?.csrf ?? '' },
        body: JSON.stringify(body),
      });
      const result = (await res.json()) as ContentOverview & { error?: string };
      if (!res.ok) throw new Error(result.error);
      if (result.authenticated !== undefined) setData(result);
      else await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not save changes.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function act(action: ContentAction, jobs: ContentJob[]) {
    const ids = jobs.filter((j) => canApply(action, j)).map((j) => j.id);
    if (!ids.length) return false;
    const n = `${ids.length} Short${ids.length === 1 ? '' : 's'}`;
    if (action === 'publish' && !window.confirm(`Publish ${n} publicly to ${data?.channel?.title ?? 'YouTube'}?`))
      return false;
    if (action === 'discard' && ids.length > 1 && !window.confirm(`Discard ${n}? You can restore them later.`))
      return false;
    const ok = await post('/jobs/action', { action, ids });
    if (ok) setSelected(new Set());
    return ok;
  }

  const jobs = useMemo(() => data?.jobs ?? [], [data]);
  const byTab = useMemo(() => {
    const groups = Object.fromEntries(TABS.map((t) => [t.id, [] as ContentJob[]])) as Record<TabId, ContentJob[]>;
    for (const job of jobs) {
      // Skip statuses this build doesn't know (e.g. a backend from before the lifecycle cleanup) rather than crash.
      const tab = TABS.find((t) => (t.statuses as readonly string[]).includes(job.status));
      if (tab) groups[tab.id].push(job);
    }
    // In-flight uploads first, then the queue in the worker's order (jobs arrive newest first; it takes the oldest).
    const inFlight = (j: ContentJob) => Number(j.status === 'scheduled');
    groups.scheduled.sort((a, b) => inFlight(a) - inFlight(b) || a.createdAt - b.createdAt);
    // Ready Shorts lead the review grid; ones still rendering trail it.
    groups.review.sort((a, b) => Number(a.status !== 'ready') - Number(b.status !== 'ready'));
    return groups;
  }, [jobs]);

  const visibleJobs = byTab[tabId];
  const actionable = visibleJobs.filter((j) => tab.actions.some((a) => canApply(a, j)));
  const chosen = actionable.filter((j) => selected.has(j.id));
  const preview = jobs.find((j) => j.id === previewId);
  const rendering = byTab.review.filter((j) => j.status !== 'ready').length;

  const disabled = busy || offline;
  const authFailed = params.get('auth') === 'failed';
  const connected = Boolean(data?.authenticated && data.channel && !data.connectionError);
  const settings = data?.settings;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <main className={styles.page}>
      <header className={styles.top}>
        <div className={styles.titleBlock}>
          <h1 className={admin.pageTitle}>Shorts</h1>
          <span className={admin.sub}>
            {offline
              ? 'Service unreachable'
              : !data
                ? 'Loading…'
                : !data.authenticated
                  ? 'Signed out'
                  : data.channel
                    ? `Publishing to ${data.channel.title}`
                    : 'No YouTube channel connected'}
          </span>
        </div>
        {data?.authenticated && settings && (
          <div className={admin.actions}>
            {data.channel && (
              <button
                type="button"
                className="sl-button small secondary"
                disabled={disabled}
                aria-pressed={!settings.enabled}
                onClick={() => void post('/settings', { ...settings, enabled: !settings.enabled })}
              >
                {settings.enabled ? <Pause size={14} /> : <Play size={14} />}
                {settings.enabled ? 'Pause uploads' : 'Resume uploads'}
              </button>
            )}
            <button type="button" className="sl-button small secondary" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={14} /> Settings
            </button>
          </div>
        )}
      </header>

      {(error || authFailed || data?.connectionError) && (
        <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">
          {error ||
            data?.connectionError ||
            'Google sign-in failed. Check the allowed account, channel, permissions and OAuth configuration.'}
        </p>
      )}
      {data && !data.configured && (
        <p className={styles.notice}>
          Google sign-in needs setup. Missing: <code className="mono">{data.missing.join(' · ')}</code>
        </p>
      )}
      {data?.configured && !data.authenticated && (
        <div className={styles.connect}>
          <p className={admin.sub}>Sign in to review generated Shorts and choose which to publish.</p>
          <a className="sl-button small" href={apiUrl('/api/content/auth/start')}>
            Sign in with Google
          </a>
        </div>
      )}
      {data?.configured && data.authenticated && (!data.channel || data.connectionError) && (
        <div className={styles.connect}>
          <p className={admin.sub}>
            Shorts keep rendering into Review. Connect a YouTube channel to publish the ones you choose.
          </p>
          <a className="sl-button small" href={apiUrl('/api/content/auth/start?mode=connect')}>
            {data.channel ? 'Reconnect YouTube' : 'Connect YouTube'}
          </a>
        </div>
      )}

      {data?.authenticated && (
        <>
          <Worker
            schedule={data.schedule}
            job={jobs.find((j) => j.id === data.schedule?.jobId)}
            queued={byTab.scheduled.filter((j) => j.status === 'scheduled').length}
            now={now}
          />

          <div className={styles.tabs} role="tablist" aria-label="Shorts by stage">
            {TABS.map((t) => {
              const count = t.id === 'review' ? byTab.review.length - rendering : byTab[t.id].length;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={t.id === tabId}
                  className={`${styles.tab} ${t.id === tabId ? styles.tabActive : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  <span className={`${styles.tabCount} ${t.id === 'failed' && count ? styles.tabCountBad : ''}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <section className={styles.body} role="tabpanel" aria-label={tab.label}>
            {tab.actions.length > 0 && (
              <div className={styles.toolbar}>
                <label className={styles.selectAll}>
                  <input
                    type="checkbox"
                    disabled={!actionable.length}
                    checked={actionable.length > 0 && chosen.length === actionable.length}
                    ref={(el) => {
                      if (el) el.indeterminate = chosen.length > 0 && chosen.length < actionable.length;
                    }}
                    onChange={(e) => setSelected(new Set(e.target.checked ? actionable.map((j) => j.id) : []))}
                  />
                  {chosen.length ? `${chosen.length} selected` : 'Select all'}
                </label>
                {tabId === 'review' && rendering > 0 && (
                  <span className={admin.listMeta}>{rendering} still rendering</span>
                )}
                <div className={admin.actions}>
                  {[...tab.actions].reverse().map((action, i, list) => {
                    const count = chosen.filter((j) => canApply(action, j)).length;
                    const primary = i === list.length - 1;
                    return (
                      <button
                        key={action}
                        type="button"
                        className={`sl-button small ${primary ? '' : 'secondary'}`}
                        disabled={disabled || !count || (action === 'publish' && !connected)}
                        title={action === 'publish' && !connected ? 'Connect YouTube first' : undefined}
                        onClick={() => void act(action, chosen)}
                      >
                        {ACTION_LABELS[action]}
                        {count ? ` ${count}` : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {tabId === 'scheduled' && settings && byTab.scheduled.length > 0 && (
              <p className={styles.hint}>
                Uploads go out oldest first
                {settings.intervalMinutes ? `, at least ${settings.intervalMinutes} min apart` : ''}
                {settings.dailyLimit ? `, up to ${settings.dailyLimit} a day` : ''}.
              </p>
            )}

            {visibleJobs.length ? (
              <ul className={styles.grid}>
                {visibleJobs.map((job, index) => {
                  const selectable = tab.actions.some((a) => canApply(a, job));
                  const isSelected = selectable && selected.has(job.id);
                  return (
                    <li key={job.id} className={`${styles.card} ${isSelected ? styles.cardSelected : ''}`}>
                      <button
                        type="button"
                        className={styles.thumb}
                        disabled={!job.rendered}
                        onClick={() => setPreviewId(job.id)}
                        aria-label={`Preview ${title(job)}`}
                      >
                        {job.rendered ? (
                          <video
                            src={`${apiUrl(`/api/content/jobs/${job.id}/video`)}#t=1`}
                            preload="metadata"
                            muted
                            playsInline
                          />
                        ) : (
                          <span className={styles.thumbPending}>
                            {['pending', 'rendering'].includes(job.status) ? `${LABELS[job.status]}…` : 'No video'}
                          </span>
                        )}
                        {tabId === 'scheduled' && job.status === 'scheduled' && (
                          <span className={styles.position}>
                            #{index + 1 - byTab.scheduled.filter((j) => j.status !== 'scheduled').length}
                          </span>
                        )}
                      </button>
                      {selectable && (
                        <label className={styles.check} aria-label={`Select ${title(job)}`}>
                          <input type="checkbox" checked={isSelected} onChange={() => toggle(job.id)} />
                          <Check size={12} aria-hidden />
                        </label>
                      )}
                      <div className={styles.meta}>
                        <span className={styles.cardTitle}>{title(job)}</span>
                        <span className={admin.listMeta}>
                          {job.highlight.sportId} · peak {job.highlight.peak.score} · {day(job.createdAt)}{' '}
                          {time(job.createdAt)}
                        </span>
                        {(tab.statuses.length > 1 || job.status === 'failed') && job.status !== 'ready' && (
                          <span className={`${admin.status} ${admin[`status_${TONES[job.status]}`]}`}>
                            {LABELS[job.status]}
                          </span>
                        )}
                        {job.message && <span className={styles.message}>{job.message}</span>}
                        {job.videoId && (
                          <a
                            className={admin.extLink}
                            href={`https://www.youtube.com/shorts/${encodeURIComponent(job.videoId)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            YouTube <ArrowUpRight size={12} />
                          </a>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.empty}>{EMPTY[tabId]}</p>
            )}
          </section>
        </>
      )}

      <Dialog
        open={Boolean(preview)}
        title={preview ? title(preview) : 'Preview'}
        onClose={() => setPreviewId(undefined)}
      >
        {preview && (
          <div className={styles.preview}>
            <video
              className={styles.previewVideo}
              src={apiUrl(`/api/content/jobs/${preview.id}/video`)}
              controls
              autoPlay
              playsInline
            />
            <span className={`${admin.status} ${admin[`status_${TONES[preview.status]}`]}`}>
              {LABELS[preview.status]}
            </span>
            <p className={admin.sub}>{preview.highlight.caption?.description || preview.highlight.event.title}</p>
            {preview.message && <p className={styles.message}>{preview.message}</p>}
            <div className={admin.actions}>
              {(Object.keys(ACTION_LABELS) as ContentAction[])
                .filter((a) => canApply(a, preview))
                .map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={`sl-button small ${action === 'discard' || action === 'unschedule' ? 'secondary' : ''}`}
                    disabled={disabled || (action === 'publish' && !connected)}
                    onClick={() => void act(action, [preview]).then((ok) => ok && setPreviewId(undefined))}
                  >
                    {ACTION_LABELS[action]}
                  </button>
                ))}
              {preview.videoId && (
                <a
                  className="sl-button small secondary"
                  href={`https://www.youtube.com/shorts/${encodeURIComponent(preview.videoId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on YouTube <ArrowUpRight size={14} />
                </a>
              )}
            </div>
          </div>
        )}
      </Dialog>

      {settings && (
        <Dialog open={settingsOpen} title="Publishing settings" onClose={() => setSettingsOpen(false)}>
          <p className={admin.sub}>Signed in as {data?.user?.email}</p>
          <PublishingSettings
            key={JSON.stringify(settings)}
            settings={settings}
            disabled={disabled}
            connected={Boolean(data?.channel)}
            onSave={(s) => void post('/settings', s).then((ok) => ok && setSettingsOpen(false))}
            onDisconnect={() => {
              if (window.confirm('Disconnect the YouTube channel? Scheduled Shorts stop uploading.'))
                void post('/disconnect');
            }}
            onLogout={() => void post('/logout')}
          />
        </Dialog>
      )}
    </main>
  );
}

const EMPTY: Record<TabId, string> = {
  review: 'Nothing to review. New big moments are rendered here automatically.',
  scheduled: 'Nothing scheduled. Publish Shorts from Review to queue them for YouTube.',
  failed: 'Nothing needs your attention.',
  published: 'Nothing published yet.',
  discarded: 'No discarded Shorts.',
};

const WAIT_TEXT: Record<NonNullable<ContentSchedule['reason']>, string> = {
  interval: 'Spacing uploads',
  retry: 'Retrying shortly',
  quota: 'YouTube daily quota used',
  daily_limit: 'Daily upload limit reached',
};

const STAGES = [
  ['rendering', 'Render'],
  ['uploading', 'Upload'],
  ['processing', 'YouTube'],
  ['published', 'Live'],
] as const;

/** One line on what the publishing worker is doing, or what it is waiting for. */
function Worker({
  schedule,
  job,
  queued,
  now,
}: {
  schedule?: ContentSchedule;
  job?: ContentJob;
  queued: number;
  now: number;
}) {
  if (!schedule) return null;
  let headline: string;
  let detail: string | undefined;
  let tone: 'ok' | 'warn' | 'off' = 'off';
  if (schedule.state === 'working' && job) {
    headline = `${LABELS[job.status]}: ${title(job)}`;
    detail = `${Math.max(0, Math.floor((now - job.updatedAt) / 1000))}s`;
    tone = 'warn';
  } else if (schedule.state === 'waiting' && job) {
    headline = `Next upload: ${title(job)}`;
    detail =
      (schedule.reason ? WAIT_TEXT[schedule.reason] : 'Starting') +
      (schedule.nextAt && schedule.nextAt > now ? ` · in ${countdown(schedule.nextAt - now)}` : '');
    tone = 'ok';
  } else if (schedule.state === 'paused') {
    headline = queued ? `Uploads paused · ${queued} scheduled` : 'Uploads paused';
  } else if (schedule.state === 'blocked') {
    headline = 'Uploads blocked until a YouTube channel is connected';
  } else {
    headline = 'Idle · nothing scheduled to upload';
    tone = 'ok';
  }
  const stage = job && schedule.state === 'working' ? STAGES.findIndex(([s]) => s === job.status) : -1;
  return (
    <div className={styles.worker} aria-live="polite">
      <span className={`${styles.workerDot} ${styles[`dot_${tone}`]}`} aria-hidden />
      <span className={styles.workerHeadline}>{headline}</span>
      {detail && <span className={admin.listMeta}>{detail}</span>}
      {stage >= 0 && (
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
      )}
    </div>
  );
}

function countdown(ms: number) {
  const s = Math.ceil(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function PublishingSettings({
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
  onSave: (settings: ContentSettings) => void;
  onDisconnect: () => void;
  onLogout: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  return (
    <form
      className={styles.settings}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <div className={styles.fields}>
        {(
          [
            ['minPeak', 'Minimum peak to render', 0, 100],
            ['dailyLimit', 'Daily upload limit (0 = none)', 0, 1000],
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
      <p className={admin.sub}>
        Shorts render automatically into Review. Only Shorts you publish are uploaded, publicly. Signing out keeps
        scheduled uploads running; disconnecting the channel stops them.
      </p>
      <div className={admin.actions}>
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
    </form>
  );
}

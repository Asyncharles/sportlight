import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowBigDown, ArrowBigUp, KeyRound, Pause, Play } from 'lucide-react';
import { getSport, type AdminFeed, type AdminOverview } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { apiUrl } from '../../lib/env';
import { formatAge, formatDuration } from '../../lib/format';
import { useDocumentVisible } from '../../lib/hooks';
import { ContentOverview } from './ContentOverview';
import { Sparkline } from './Sparkline';
import styles from './Admin.module.scss';

const POLL_MS = 1000;
const TOKEN_KEY = 'sportlight.adminToken';

/** Operations view of every stream, polled from the backend. */
export function Admin() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [paused, setPaused] = useState(false);
  const [showEnded, setShowEnded] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const visible = useDocumentVisible();
  const [storageMessage, setStorageMessage] = useState('');
  const [clearing, setClearing] = useState(false);
  async function clearStorage() {
    if (!window.confirm('Delete history and highlight archive files older than 7 days? Recent data and publishing jobs will be kept.')) return;
    setClearing(true);
    try {
      const response = await fetch(apiUrl('/api/admin/storage/clear'), {
        method: 'POST', headers: { 'X-Sportlight-Action': 'clear-archived-storage', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as { files: number; bytes: number };
      setStorageMessage(`Cleared ${result.files} files (${(result.bytes / 1048576).toFixed(1)} MB).`);
    } catch (error) { setStorageMessage(`Cleanup failed: ${(error as Error).message}`); }
    finally { setClearing(false); }
  }

  useEffect(() => {
    if (paused || !visible || needsToken) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl('/api/admin/overview'), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.status === 401) {
          setNeedsToken(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as AdminOverview;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
      if (!cancelled) timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paused, visible, token, needsToken]);

  const feeds = useMemo(() => {
    const order = { live: 0, unavailable: 1, ended: 2 } as const;
    return (data?.feeds ?? [])
      .filter((f) => showEnded || f.status !== 'ended')
      .sort((a, b) => order[a.status] - order[b.status] || (b.intensity?.score ?? 0) - (a.intensity?.score ?? 0));
  }, [data, showEnded]);

  if (needsToken) {
    return (
      <main className={styles.page}>
        <form
          className={styles.tokenForm}
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem(TOKEN_KEY, token);
            setNeedsToken(false);
          }}
        >
          <KeyRound size={20} />
          <label htmlFor="admin-token">Admin token</label>
          <input id="admin-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
          <button className="sl-button small" type="submit">
            Continue
          </button>
        </form>
      </main>
    );
  }

  const counts = data
    ? {
        live: data.feeds.filter((f) => f.status === 'live').length,
        unavailable: data.feeds.filter((f) => f.status === 'unavailable').length,
        ended: data.feeds.filter((f) => f.status === 'ended').length,
      }
    : null;
  const dropped = data ? Object.values(data.events.dropped).reduce<number>((a, b) => a + (b ?? 0), 0) : 0;

  return (
    <main className={styles.page}>
      <section className={styles.section}>
        <h2>Storage</h2>
        <p>Clear history and highlight archive files older than 7 days. Recent data, publishing jobs and videos are kept.</p>
        <button className="sl-button small" disabled={clearing} onClick={() => void clearStorage()}>{clearing ? 'Clearing…' : 'Clear old archives'}</button>
        <p role="status">{storageMessage}</p>
      </section>
      <section className={styles.section} aria-labelledby="streams-heading">
      <div className={styles.sectionHead}>
        <div>
          <h2 id="streams-heading" className={styles.sectionTitle}>
            Streams
          </h2>
          <p className={styles.sub}>
            {error ? (
              <span className={styles.err}>Backend unreachable · {error}</span>
            ) : data ? (
              `Backend up ${formatDuration(data.uptimeSec)}`
            ) : (
              'Loading…'
            )}
          </p>
        </div>
        <div className={styles.actions}>
          <label className={styles.toggle}>
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended
          </label>
          <button
            type="button"
            className="sl-button small secondary"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {data && counts && (
        <section className={styles.cards} aria-label="Summary">
          <Card
            label="Broker"
            value={data.amqp.connected ? 'Connected' : 'Down'}
            tone={data.amqp.connected ? 'ok' : 'bad'}
          >
            {data.amqp.queue} · depth {data.amqp.queueDepth ?? '—'} · {data.amqp.ratePerSec.toFixed(1)} msg/s
            {data.amqp.lastError && !data.amqp.connected ? ` · ${data.amqp.lastError}` : ''}
          </Card>
          <Card label="Feeds" value={`${counts.live} live`} tone={counts.unavailable ? 'warn' : 'ok'}>
            {counts.unavailable} unavailable · {counts.ended} recently ended
          </Card>
          <Card label="Events" value={data.events.applied.toLocaleString()}>
            {dropped} dropped · {data.events.lateIntensity} late · {data.amqp.invalid} invalid
          </Card>
          <Card label="Viewers" value={String(data.websocket.clients)}>
            {data.viewers.filter((v) => v.tiles.length).length} watching · {data.highlights.count} highlights today
          </Card>
        </section>
      )}

      <section className={styles.tableWrap} aria-label="Feeds">
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Feed</th>
              <th>Status</th>
              <th className={styles.num}>Intensity</th>
              <th>Last 2 min</th>
              <th className={styles.num} title="Time since the last event from the provider">
                Last update
              </th>
              <th className={styles.num} title="Provider → backend delivery lag (latest / average)">
                Delivery lag
              </th>
              <th className={styles.num} title="How far the latest intensity reading trails the live edge">
                Behind live
              </th>
              <th className={styles.num}>Viewers</th>
              <th className={styles.num}>Votes</th>
              <th className={styles.num}>Uptime</th>
            </tr>
          </thead>
          <tbody>
            {feeds.map((f) => (
              <Fragment key={f.id}>
                <tr
                  className={`${f.status === 'ended' ? styles.ended : ''} ${expanded === f.id ? styles.expandedRow : ''}`}
                  onClick={() => setExpanded((e) => (e === f.id ? null : f.id))}
                >
                  <td>
                    <div className={styles.feed}>
                      <SportIcon sportId={f.sportId} size={15} />
                      <div>
                        <div className={styles.feedTitle}>{f.title}</div>
                        <div className={`${styles.feedId} mono`}>{f.id}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Status feed={f} />
                  </td>
                  <td className={`${styles.num} mono`}>
                    <span className={f.intensityStale ? styles.stale : undefined}>
                      {f.intensity ? Math.round(f.intensity.score) : '—'}
                    </span>
                  </td>
                  <td>
                    <Sparkline points={f.recent} />
                  </td>
                  <td
                    className={`${styles.num} mono ${f.lastEventAgeMs > 5000 && f.status !== 'ended' ? styles.warnText : ''}`}
                  >
                    {formatAge(f.lastEventAgeMs)}
                  </td>
                  <td className={`${styles.num} mono`}>
                    {formatAge(f.deliveryLagMs)} <span className={styles.dim}>/ {formatAge(f.avgDeliveryLagMs)}</span>
                  </td>
                  <td className={`${styles.num} mono`}>
                    {f.streamLagSec === null ? '—' : `${f.streamLagSec.toFixed(1)}s`}
                  </td>
                  <td className={`${styles.num} mono`}>
                    {f.viewers}
                    {f.viewers > 0 && (
                      <span className={styles.dim}>
                        {' '}
                        · {f.mainViewers} main
                        {f.avgViewerLagSec !== null && f.avgViewerLagSec > 0.5
                          ? ` · −${f.avgViewerLagSec.toFixed(0)}s`
                          : ''}
                      </span>
                    )}
                  </td>
                  <td className={`${styles.num} mono`}>
                    <span className={styles.votes}>
                      <ArrowBigUp size={13} />
                      {f.votes.up}
                      <ArrowBigDown size={13} />
                      {f.votes.down}
                    </span>
                  </td>
                  <td className={`${styles.num} mono`}>{formatDuration(f.uptimeSec)}</td>
                </tr>
                {expanded === f.id && (
                  <tr className={styles.detailRow}>
                    <td colSpan={10}>
                      <dl className={styles.detail}>
                        <Detail k="Run" v={f.runId} />
                        <Detail k="Provider" v={f.provider} />
                        <Detail k="Sequence" v={String(f.seq)} />
                        <Detail k="Sport" v={getSport(f.sportId)?.name ?? f.sportId} />
                        <Detail k="Started" v={new Date(f.startedAt).toLocaleTimeString()} />
                        <Detail k="Media" v={`${f.media.url} (${formatDuration(f.media.durationSec)} loop)`} />
                        <Detail k="Events applied" v={String(f.events.applied)} />
                        <Detail k="Late readings" v={String(f.events.lateIntensity)} />
                        <Detail
                          k="Dropped"
                          v={
                            Object.entries(f.events.dropped)
                              .map(([r, n]) => `${r} ${n}`)
                              .join(', ') || 'none'
                          }
                        />
                        <Detail k="Last intensity" v={formatAge(f.lastIntensityAgeMs)} />
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {data && feeds.length === 0 && (
              <tr>
                <td colSpan={10} className={styles.none}>
                  No feeds. Is the publisher running?
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {data && data.viewers.length > 0 && (
        <section className={styles.tableWrap} aria-label="Viewers">
          <h2 className={styles.h2}>Viewers</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Viewer</th>
                <th>Follows</th>
                <th>Watching</th>
                <th className={styles.num}>Connected</th>
              </tr>
            </thead>
            <tbody>
              {data.viewers.map((v) => (
                <tr key={v.sessionId}>
                  <td className="mono">{(v.viewerId ?? v.sessionId).slice(0, 8)}</td>
                  <td>
                    <span className={styles.follows}>
                      {v.follows
                        .filter((f) => f.kind === 'sport')
                        .map((f) => (
                          <SportIcon key={f.id} sportId={f.id} size={14} aria-label={f.id} />
                        ))}
                    </span>
                  </td>
                  <td className={styles.watching}>
                    {v.tiles.map((t) => (
                      <span key={t.slot} className={`${styles.tilePill} ${t.slot === 'main' ? styles.mainPill : ''}`}>
                        {data.feeds.find((f) => f.id === t.feedId)?.title ?? t.feedId}
                        {t.playback !== 'playing' && <em> · {t.playback}</em>}
                        {t.lagSec > 1 && <em> · −{Math.round(t.lagSec)}s</em>}
                      </span>
                    ))}
                  </td>
                  <td className={`${styles.num} mono`}>{formatDuration(v.connectedSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      </section>

      <ContentOverview />

      {data && (
        <details className={styles.config}>
          <summary>Effective configuration</summary>
          <pre className="mono">{JSON.stringify(data.config, null, 2)}</pre>
        </details>
      )}
    </main>
  );
}

function Card({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
  children: React.ReactNode;
}) {
  return (
    <div className={styles.card}>
      <div className={styles.cardLabel}>{label}</div>
      <div className={`${styles.cardValue} ${tone ? styles[tone] : ''}`}>{value}</div>
      <div className={styles.cardSub}>{children}</div>
    </div>
  );
}

function Status({ feed: f }: { feed: AdminFeed }) {
  const label =
    f.status === 'live'
      ? f.intensityStale
        ? 'Live · stale'
        : 'Live'
      : f.status === 'unavailable'
        ? f.unavailableReason === 'silent'
          ? 'Silent'
          : 'Unavailable'
        : `Ended${f.endReason ? ` · ${f.endReason}` : ''}`;
  const tone = f.status === 'live' ? (f.intensityStale ? 'warn' : 'ok') : f.status === 'unavailable' ? 'bad' : 'off';
  return <span className={`${styles.status} ${styles[`status_${tone}`]}`}>{label}</span>;
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd className="mono">{v}</dd>
    </div>
  );
}

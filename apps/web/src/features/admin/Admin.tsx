import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowBigDown, ArrowBigUp, Pause, Play, SlidersHorizontal } from 'lucide-react';
import { getSport, type AdminFeed, type AdminOverview } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { apiUrl } from '../../lib/env';
import { formatAge, formatDuration } from '../../lib/format';
import { useDocumentVisible } from '../../lib/hooks';
import { Dialog } from './Dialog';
import { Sparkline } from './Sparkline';
import styles from './Admin.module.scss';

const POLL_MS = 1000;
const COLS = 9;

/** Operations view of every stream, polled from the backend. Fits one screen; panels scroll internally. */
export function Admin() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showEnded, setShowEnded] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [systemOpen, setSystemOpen] = useState(false);
  const visible = useDocumentVisible();

  useEffect(() => {
    if (paused || !visible) return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl('/api/admin/overview'));
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
  }, [paused, visible]);

  const feeds = useMemo(() => {
    const order = { live: 0, unavailable: 1, ended: 2 } as const;
    return (data?.feeds ?? [])
      .filter((f) => showEnded || f.status !== 'ended')
      .sort((a, b) => order[a.status] - order[b.status] || (b.intensity?.score ?? 0) - (a.intensity?.score ?? 0));
  }, [data, showEnded]);

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
      <header className={styles.topBar}>
        <div className={styles.titleBlock}>
          <h1 className={styles.pageTitle}>Operations</h1>
          <span className={styles.sub}>
            {error ? (
              <span className={styles.err}>Backend unreachable · {error}</span>
            ) : data ? (
              <>
                <span className={`${styles.dot} ${paused ? styles.dotOff : ''}`} aria-hidden />
                {paused ? 'Paused' : 'Live'} · backend up {formatDuration(data.uptimeSec)}
              </>
            ) : (
              'Loading…'
            )}
          </span>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className="sl-button small secondary"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="sl-button small secondary" onClick={() => setSystemOpen(true)}>
            <SlidersHorizontal size={14} /> System
          </button>
        </div>
      </header>

      <section className={styles.cards} aria-label="Summary">
        <Card
          label="Broker"
          value={data ? (data.amqp.connected ? 'Connected' : 'Down') : '—'}
          tone={data ? (data.amqp.connected ? 'ok' : 'bad') : undefined}
        >
          {data && (
            <>
              depth {data.amqp.queueDepth ?? '—'} · {data.amqp.ratePerSec.toFixed(1)} msg/s
              {data.amqp.lastError && !data.amqp.connected ? ` · ${data.amqp.lastError}` : ''}
            </>
          )}
        </Card>
        <Card label="Feeds" value={counts ? `${counts.live} live` : '—'} tone={counts?.unavailable ? 'warn' : 'ok'}>
          {counts && `${counts.unavailable} unavailable · ${counts.ended} ended`}
        </Card>
        <Card label="Events" value={data ? data.events.applied.toLocaleString() : '—'}>
          {data && `${dropped} dropped · ${data.events.lateIntensity} late · ${data.amqp.invalid} invalid`}
        </Card>
        <Card label="Viewers" value={data ? String(data.websocket.clients) : '—'}>
          {data &&
            `${data.viewers.filter((v) => v.tiles.length).length} watching · ${data.highlights.count} highlights today`}
        </Card>
      </section>

      <div className={styles.grid}>
        <section className={`${styles.panel} ${styles.streams}`} aria-labelledby="streams-heading">
          <div className={styles.panelHead}>
            <h2 id="streams-heading" className={styles.panelTitle}>
              Streams <span className={styles.count}>{feeds.length}</span>
            </h2>
            <label className={styles.toggle}>
              <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show ended
            </label>
          </div>
          <div className={styles.panelBody}>
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
                </tr>
              </thead>
              <tbody>
                {feeds.map((f) => (
                  <Fragment key={f.id}>
                    <tr
                      className={`${f.status === 'ended' ? styles.ended : ''} ${expanded === f.id ? styles.expandedRow : ''}`}
                      onClick={() => setExpanded((e) => (e === f.id ? null : f.id))}
                      aria-expanded={expanded === f.id}
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
                        <Sparkline points={f.recent} width={100} height={22} />
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
                    </tr>
                    {expanded === f.id && (
                      <tr className={styles.detailRow}>
                        <td colSpan={COLS}>
                          <dl className={styles.detail}>
                            <Detail k="Run" v={f.runId} />
                            <Detail k="Provider" v={f.provider} />
                            <Detail k="Sequence" v={String(f.seq)} />
                            <Detail k="Sport" v={getSport(f.sportId)?.name ?? f.sportId} />
                            <Detail k="Started" v={new Date(f.startedAt).toLocaleTimeString()} />
                            <Detail k="Uptime" v={formatDuration(f.uptimeSec)} />
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
                    <td colSpan={COLS} className={styles.none}>
                      No feeds. Is the publisher running?
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={`${styles.panel} ${styles.viewers}`} aria-labelledby="viewers-heading">
          <div className={styles.panelHead}>
            <h2 id="viewers-heading" className={styles.panelTitle}>
              Viewers <span className={styles.count}>{data?.viewers.length ?? 0}</span>
            </h2>
          </div>
          <div className={styles.panelBody}>
            {data && data.viewers.length > 0 ? (
              <ul className={styles.list}>
                {data.viewers.map((v) => (
                  <li key={v.sessionId} className={styles.listItem}>
                    <div className={styles.listMain}>
                      <span className="mono">{(v.viewerId ?? v.sessionId).slice(0, 8)}</span>
                      <span className={styles.follows}>
                        {v.follows
                          .filter((f) => f.kind === 'sport')
                          .map((f) => (
                            <SportIcon key={f.id} sportId={f.id} size={13} aria-label={f.id} />
                          ))}
                      </span>
                      <span className={`${styles.listMeta} mono`}>{formatDuration(v.connectedSec)}</span>
                    </div>
                    {v.tiles.length > 0 && (
                      <div className={styles.watching}>
                        {v.tiles.map((t) => (
                          <span key={t.slot} className={`${styles.tilePill} ${t.slot === 'main' ? styles.mainPill : ''}`}>
                            {data.feeds.find((f) => f.id === t.feedId)?.title ?? t.feedId}
                            {t.playback !== 'playing' && <em> · {t.playback}</em>}
                            {t.lagSec > 1 && <em> · −{Math.round(t.lagSec)}s</em>}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.none}>{data ? 'No viewers connected.' : 'Loading…'}</p>
            )}
          </div>
        </section>
      </div>

      <Dialog open={systemOpen} title="System" onClose={() => setSystemOpen(false)}>
        <SystemTools config={data?.config} />
      </Dialog>
    </main>
  );
}

type ClearTarget = 'highlights' | 'history' | 'archives';

const CLEANUPS: { target: ClearTarget; title: string; hint: string; button: string; confirm: string }[] = [
  {
    target: 'highlights',
    title: 'Best of today',
    hint: 'Every highlight from every day, including today. Viewers’ lists empty straight away; new moments still come in.',
    button: 'Clear all highlights',
    confirm: 'Delete every “Best of today” highlight for all days, including today? This cannot be undone.',
  },
  {
    target: 'history',
    title: 'Intensity history',
    hint: 'The recorded intensity readings for all days. Live trend lines keep the last hour from memory.',
    button: 'Clear all history',
    confirm: 'Delete the intensity history for all days? This cannot be undone.',
  },
  {
    target: 'archives',
    title: 'Old archives',
    hint: 'History and highlight files older than 7 days. Recent data is kept.',
    button: 'Clear old archives',
    confirm: 'Delete history and highlight archive files older than 7 days?',
  },
];

function SystemTools({ config }: { config: unknown }) {
  const [messages, setMessages] = useState<Partial<Record<ClearTarget, string>>>({});
  const [clearing, setClearing] = useState<ClearTarget | null>(null);

  async function clear(c: (typeof CLEANUPS)[number]) {
    if (!window.confirm(c.confirm)) return;
    setClearing(c.target);
    let message: string;
    try {
      const response = await fetch(apiUrl(`/api/admin/storage/clear?target=${c.target}`), {
        method: 'POST',
        headers: { 'X-Sportlight-Action': 'clear-archived-storage' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const r = (await response.json()) as { files: number; bytes: number; items?: number };
      const size = `${r.files} file${r.files === 1 ? '' : 's'}, ${(r.bytes / 1048576).toFixed(1)} MB`;
      message =
        r.items === undefined ? `Cleared ${size}.` : `Cleared ${r.items} highlight${r.items === 1 ? '' : 's'} (${size}).`;
    } catch (error) {
      message = `Cleanup failed: ${(error as Error).message}`;
    } finally {
      setClearing(null);
    }
    setMessages((m) => ({ ...m, [c.target]: message }));
  }

  return (
    <>
      <div className={styles.dialogSection}>
        <h3>Storage</h3>
        {CLEANUPS.map((c) => (
          <div key={c.target} className={styles.cleanup}>
            <div>
              <strong>{c.title}</strong>
              <p className={styles.sub}>{c.hint}</p>
              {messages[c.target] && (
                <p className={styles.sub} role="status">
                  {messages[c.target]}
                </p>
              )}
            </div>
            <button className="sl-button small" disabled={clearing !== null} onClick={() => void clear(c)}>
              {clearing === c.target ? 'Clearing…' : c.button}
            </button>
          </div>
        ))}
        <p className={styles.sub}>
          Shorts are cleared from the <a href="/admin/shorts">Shorts dashboard</a> (Publishing settings), behind its
          Google sign-in.
        </p>
      </div>
      <div className={styles.dialogSection}>
        <h3>Effective configuration</h3>
        <pre className={`${styles.pre} mono`}>{config ? JSON.stringify(config, null, 2) : 'Loading…'}</pre>
      </div>
    </>
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
  children?: React.ReactNode;
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

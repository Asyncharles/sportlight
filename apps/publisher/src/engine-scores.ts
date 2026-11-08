import WebSocket from 'ws';

/** The fields sportlight uses from the engine's `ScoreUpdate` (SportlightEngine `schema.py`). */
export interface EngineScore {
  feed_id: string;
  t_video: number;
  loop_epoch: number;
  stale: boolean;
  /** 0 to 100 within the sport; what the front end ranks on. */
  intensity_pct: number;
  /** Engine wall clock when t_video was read (ns). */
  t_emit_ns?: number;
}

/**
 * The wall time (ms) that goes with a score's t_video. The engine stamps it as it computes the
 * score, so network delay and the last-score replay on connect do not skew the clock. Falls back to
 * the arrival time when the two machines' clocks are clearly apart.
 */
export function scoreTimeMs(score: EngineScore, receivedAtMs: number, maxSkewMs = 10_000): number {
  const emitted = score.t_emit_ns === undefined ? undefined : score.t_emit_ns / 1e6;
  return emitted !== undefined && Math.abs(receivedAtMs - emitted) <= maxSkewMs ? emitted : receivedAtMs;
}

export function parseEngineScore(raw: string): EngineScore | null {
  try {
    const m = JSON.parse(raw) as Partial<EngineScore>;
    if (
      typeof m.feed_id !== 'string' ||
      typeof m.t_video !== 'number' ||
      typeof m.loop_epoch !== 'number' ||
      typeof m.intensity_pct !== 'number'
    )
      return null;
    return {
      feed_id: m.feed_id,
      t_video: m.t_video,
      loop_epoch: m.loop_epoch,
      stale: Boolean(m.stale),
      intensity_pct: Math.min(100, Math.max(0, m.intensity_pct)),
      ...(typeof m.t_emit_ns === 'number' ? { t_emit_ns: m.t_emit_ns } : {}),
    };
  } catch {
    return null;
  }
}

/** Follows the engine's `/ws/scores` and reconnects with backoff. Returns a stop function. */
export function followEngineScores(
  url: string,
  onScore: (score: EngineScore, receivedAtMs: number) => void,
  log: (msg: string, fields?: Record<string, unknown>) => void,
): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.on('open', () => {
      attempt = 0;
      log('connected to engine scores', { url });
    });
    ws.on('message', (data) => {
      const score = parseEngineScore(data.toString());
      if (score) onScore(score, Date.now());
    });
    ws.on('error', (err) => log('engine scores error', { err: err.message }));
    ws.on('close', () => {
      if (stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** attempt++);
      log('engine scores closed, reconnecting', { inMs: delay });
      timer = setTimeout(connect, delay);
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}

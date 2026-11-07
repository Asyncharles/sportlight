/** Minimal structured logger: JSON lines in production, readable lines in development. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;
const json = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[level] < minLevel) return;
    const normalized =
      fields && Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? v.message : v]));
    if (json) {
      // Cloud Logging understands `severity`.
      console.log(
        JSON.stringify({ severity: level.toUpperCase(), time: new Date().toISOString(), scope, msg, ...normalized }),
      );
    } else {
      const extra = normalized && Object.keys(normalized).length ? ' ' + JSON.stringify(normalized) : '';
      const line = `${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} [${scope}] ${msg}${extra}`;
      (level === 'error' ? console.error : console.log)(line);
    }
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}

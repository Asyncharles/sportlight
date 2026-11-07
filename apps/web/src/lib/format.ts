export function formatClock(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(ms);
}

export function formatTimeOfDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(Date.parse(iso));
}

/** 75 → "1:15". */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function formatAge(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms / 1000);
}

/** "2026-11-07" → "Saturday 7 November" (the day key is already in the configured timezone). */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    Date.UTC(y!, m! - 1, d!),
  );
}

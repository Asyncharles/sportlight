/**
 * Runtime endpoints. By default everything is same-origin (nginx in Docker, the Vite proxy in dev).
 * Packaged apps (Capacitor, Electron, Tauri) set VITE_API_URL / VITE_MEDIA_URL to the hosted
 * backend and media origin.
 */
const apiBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const mediaBase = (import.meta.env.VITE_MEDIA_URL as string | undefined)?.replace(/\/$/, '') ?? apiBase;

export const routerMode: 'browser' | 'hash' = import.meta.env.VITE_ROUTER === 'hash' ? 'hash' : 'browser';

export function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

export function wsUrl(path: string): string {
  if (apiBase) return apiBase.replace(/^http/, 'ws') + path;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

/** Resolve media URLs from the provider (absolute or origin-relative). */
export function mediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^[a-z]+:\/\//i.test(url)) return url;
  return `${mediaBase}${url.startsWith('/') ? '' : '/'}${url}`;
}

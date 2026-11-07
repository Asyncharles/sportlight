import { open, stat } from 'node:fs/promises';
import type { Highlight } from '@sportlight/shared';

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];
export class GoogleError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Google request failed (${status}: ${reason})`);
  }
}
export async function googleFetch(url: string, init: RequestInit = {}) {
  // YouTube uses 308 for resumable-upload progress. Inspect it without following redirects.
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000), redirect: 'manual' });
  if (!response.ok && response.status !== 308) {
    const data = (await response.json().catch(() => ({}))) as { error?: string | { errors?: { reason?: string }[] } };
    const reason = typeof data.error === 'string' ? data.error : (data.error?.errors?.[0]?.reason ?? 'request_failed');
    throw new GoogleError(response.status, reason);
  }
  return response;
}
export async function tokenRequest(params: Record<string, string>) {
  const response = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return (await response.json()) as { access_token: string; refresh_token?: string; scope?: string };
}
export function uploadMetadata(highlight: Highlight) {
  const clean = (s: string) => s.replace(/[<>]/g, '').trim();
  return {
    snippet: {
      title: `${clean(highlight.caption?.title || highlight.event.title).slice(0, 90)} #Shorts`,
      description: `${clean(highlight.caption?.description || highlight.event.title).slice(0, 4000)}\n\n${clean(highlight.event.title)} · Sportlight\n#Shorts #Sportlight`,
      tags: ['Shorts', 'Sportlight', highlight.sportId],
      categoryId: '17',
    },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
  };
}
export async function beginUpload(token: string, file: string, highlight: Highlight) {
  const response = await googleFetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String((await stat(file)).size),
      },
      body: JSON.stringify(uploadMetadata(highlight)),
    },
  );
  const location = response.headers.get('location');
  if (!location || new URL(location).protocol !== 'https:' || new URL(location).hostname !== 'www.googleapis.com') {
    throw new Error('Google returned an invalid upload session');
  }
  return location;
}

/** Probe first on every attempt; upload only the missing bytes of the existing session. */
export async function resumeUpload(token: string, session: string, file: string) {
  const size = (await stat(file)).size;
  const headers = { Authorization: `Bearer ${token}` };
  let response = await googleFetch(session, {
    method: 'PUT',
    headers: { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
  });
  const handle = await open(file, 'r');
  let previousOffset = -1;
  try {
    while (response.status === 308) {
      const range = response.headers.get('range');
      const start = range ? Number(/bytes=0-(\d+)/.exec(range)?.[1] ?? NaN) + 1 : 0;
      if (!Number.isSafeInteger(start) || start < 0 || start >= size)
        throw new Error('Upload offset requires reconciliation');
      if (start <= previousOffset) throw new Error('Upload made no progress; retry the existing session');
      previousOffset = start;
      const count = Math.min(8 * 1024 * 1024, size - start);
      const buffer = Buffer.alloc(count);
      const { bytesRead } = await handle.read(buffer, 0, count, start);
      if (bytesRead !== count) throw new Error('Rendered file changed during upload');
      response = await googleFetch(session, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'video/mp4',
          'Content-Length': String(count),
          'Content-Range': `bytes ${start}-${start + count - 1}/${size}`,
        },
        body: new Uint8Array(buffer),
      });
    }
    const video = (await response.json()) as { id?: string; status?: { privacyStatus?: string } };
    if (!video.id) throw new Error('Upload result requires reconciliation');
    return video;
  } finally {
    await handle.close();
  }
}

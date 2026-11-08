import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Highlight } from '@sportlight/shared';
import { apiUrl } from './env';
import { live, useLive } from './live-client';
import { preferencesStore } from './preferences';
import { useStore } from './store';

interface HighlightsState {
  day: string | null;
  timezone: string | null;
  highlights: Highlight[];
  status: 'loading' | 'ready' | 'error';
  reload: () => void;
}

const Ctx = createContext<HighlightsState | null>(null);

const byPeak = (a: Highlight, b: Highlight) => b.peak.score - a.peak.score || a.startedAt.localeCompare(b.startedAt);

/**
 * Today's highlights: fetched over REST, then kept current from WebSocket `highlight` events.
 * Refetched after every reconnect (missed events) and when the day rolls over.
 */
export function HighlightsProvider({ children }: { children: ReactNode }) {
  const { epoch } = useLive();
  const [state, setState] = useState<Omit<HighlightsState, 'reload'>>({
    day: null,
    timezone: null,
    highlights: [],
    status: 'loading',
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (epoch === 0) return;
    const ctrl = new AbortController();
    fetch(apiUrl('/api/highlights'), { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { day: string; timezone: string; highlights: Highlight[] }) =>
        setState({ day: body.day, timezone: body.timezone, highlights: body.highlights.sort(byPeak), status: 'ready' }),
      )
      .catch((err) => {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, status: s.highlights.length ? 'ready' : 'error' }));
        void err;
      });
    return () => ctrl.abort();
  }, [epoch, nonce]);

  useEffect(
    () =>
      live.onHighlight((e) =>
        setState((s) => {
          if (e.type === 'remove') return { ...s, highlights: s.highlights.filter((h) => h.id !== e.id) };
          const h = e.highlight;
          if (s.day && h.day !== s.day) {
            // A new day started: reload rather than mixing days.
            setNonce((n) => n + 1);
            return s;
          }
          return { ...s, highlights: [...s.highlights.filter((x) => x.id !== h.id), h].sort(byPeak) };
        }),
      ),
    [],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const value = useMemo(() => ({ ...state, reload }), [state, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Today's highlights as this viewer sees them: extra feeds' highlights only when extra feeds are on. */
export function useHighlights(): HighlightsState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHighlights outside HighlightsProvider');
  const showExtra = useStore(preferencesStore).extraFeeds;
  return useMemo(
    () => (showExtra || !v.highlights.some((h) => h.event.extra) ? v : { ...v, highlights: v.highlights.filter((h) => !h.event.extra) }),
    [v, showExtra],
  );
}

/** Display name of a highlight: its generated caption, falling back to the event title. */
export function highlightTitle(h: Highlight): string {
  return h.caption?.title ?? h.event.title;
}

/** True when a language model (not the built-in template) wrote the caption. */
export function isModelCaption(h: Highlight): boolean {
  return !!h.caption && h.caption.model !== 'template';
}

/** Whether the event title needs showing alongside the caption (it's not already in it). */
export function showsEventSeparately(h: Highlight): boolean {
  return !!h.caption && !h.caption.title.includes(h.event.title);
}

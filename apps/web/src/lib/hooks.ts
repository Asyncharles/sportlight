import { PHONE_QUERY } from './live-ui';
import { useEffect, useState, useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

/** True on phone-sized screens (see PHONE_QUERY), which get their own live layouts and header. */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** True when the OS asks for reduced motion or the in-app override is on. */
export function useReducedMotion(): boolean {
  const system = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [override, setOverride] = useState(() => document.documentElement.dataset.motion === 'reduce');
  useEffect(() => {
    const obs = new MutationObserver(() => setOverride(document.documentElement.dataset.motion === 'reduce'));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => obs.disconnect();
  }, []);
  return system || override;
}

/** Re-renders every `intervalMs`, aligned to wall-clock boundaries. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: number;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, intervalMs - (Date.now() % intervalMs));
    };
    timer = window.setTimeout(tick, intervalMs - (Date.now() % intervalMs));
    return () => clearTimeout(timer);
  }, [intervalMs]);
  return now;
}

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    () => document.visibilityState === 'visible',
    () => true,
  );
}

/** The applied colour theme (`data-theme` on <html>, set by useApplyAppearance). */
export function useResolvedTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

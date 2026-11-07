import { useEffect } from 'react';
import { followedSportIds, isKnownSport, sportFollows, type Follow, type SportId } from '@sportlight/shared';
import { Store, storage, useStore } from './store';

/**
 * Viewer preferences, stored locally (no accounts in the prototype). `follows` is the canonical,
 * extensible form (sports today; competitions/teams later).
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type MotionPreference = 'system' | 'reduce';

export interface Preferences {
  version: 1;
  onboarded: boolean;
  follows: Follow[];
  theme: ThemePreference;
  motion: MotionPreference;
}

const KEY = 'sportlight.prefs.v1';
const DEFAULTS: Preferences = { version: 1, onboarded: false, follows: [], theme: 'system', motion: 'system' };

function load(): Preferences {
  const saved = storage.read<Partial<Preferences>>(KEY, {});
  return {
    ...DEFAULTS,
    ...saved,
    version: 1,
    // Drop follows for sports that no longer exist in the catalogue.
    follows: (saved.follows ?? []).filter((f) => f.kind !== 'sport' || isKnownSport(f.id)),
  };
}

export const preferencesStore = new Store<Preferences>(load());
preferencesStore.subscribe(() => storage.write(KEY, preferencesStore.get()));

export function usePreferences() {
  const prefs = useStore(preferencesStore);
  return {
    prefs,
    sports: followedSportIds(prefs.follows),
    update: (patch: Partial<Preferences>) => preferencesStore.set((p) => ({ ...p, ...patch })),
    setSports: (ids: SportId[]) =>
      preferencesStore.set((p) => ({
        ...p,
        follows: [...p.follows.filter((f) => f.kind !== 'sport'), ...sportFollows(ids)],
      })),
    reset: () => {
      storage.remove(KEY);
      preferencesStore.set({ ...DEFAULTS });
    },
  };
}

/** Applies theme and motion preferences to <html>. */
export function useApplyAppearance() {
  const { prefs } = usePreferences();
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = prefs.theme === 'system' ? (media.matches ? 'dark' : 'light') : prefs.theme;
      document.documentElement.dataset.theme = theme;
      document
        .querySelectorAll('meta[name="theme-color"]')
        .forEach((m) => m.setAttribute('content', theme === 'dark' ? '#101210' : '#F7F8F4'));
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [prefs.theme]);

  useEffect(() => {
    if (prefs.motion === 'reduce') document.documentElement.dataset.motion = 'reduce';
    else delete document.documentElement.dataset.motion;
  }, [prefs.motion]);
}

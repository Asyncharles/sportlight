import { useEffect } from 'react';
import {
  followedSportIds,
  isKnownSport,
  sportFollows,
  type Follow,
  type MainPolicy,
  type SportId,
} from '@sportlight/shared';
import { Store, storage, useStore } from './store';

/**
 * Viewer preferences, stored locally (no accounts in the prototype). `follows` is the canonical,
 * extensible form (sports today; competitions/teams later).
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export const COLOUR_THEMES = [
  { value: 'lime', label: 'Lime' },
  { value: 'blue', label: 'Blue' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'orange', label: 'Orange' },
  { value: 'violet', label: 'Violet' },
] as const;
export type ColourTheme = (typeof COLOUR_THEMES)[number]['value'];
export type MotionPreference = 'system' | 'reduce';

export type LayoutId = 'table' | 'classic' | 'theatre' | 'quad';
/** Phone-only layouts: every window fits the screen without scrolling. */
export type PhoneLayoutId = 'phone-table' | 'duo' | 'trio';
export type SidebarSide = 'left' | 'right';
export type SwitchAnimation = 'spotlight' | 'stinger' | 'flip';
export type SwitchPace = 'calm' | 'balanced' | 'eager' | 'custom';

export interface LivePreferences {
  /** Opt-in experimental spatial viewing room. */
  beta3d: boolean;
  layout: LayoutId;
  /** The layout used on phones (kept separate so the desktop choice survives). */
  phoneLayout: PhoneLayoutId;
  sidebar: SidebarSide;
  animation: SwitchAnimation;
  mainPolicy: MainPolicy;
  pace: SwitchPace;
  /** Used when `pace` is `custom`. */
  custom: { minDisplaySec: number; margin: number; challengeSec: number };
  /** Warn this long before an automatic switch (0 = no warning). */
  countdownSec: number;
}

export interface Preferences {
  version: 1;
  onboarded: boolean;
  follows: Follow[];
  theme: ThemePreference;
  colour: ColourTheme;
  motion: MotionPreference;
  live: LivePreferences;
  /** Show extra sample feeds (marked `extra` by the provider) alongside the main demo feeds. */
  extraFeeds: boolean;
}

const KEY = 'sportlight.prefs.v1';
export const DEFAULT_LIVE_PREFERENCES: LivePreferences = {
  beta3d: false,
  layout: 'theatre',
  phoneLayout: 'phone-table',
  sidebar: 'left',
  animation: 'spotlight',
  mainPolicy: 'user',
  pace: 'balanced',
  custom: { minDisplaySec: 20, margin: 10, challengeSec: 3 },
  countdownSec: 5,
};
const DEFAULTS: Preferences = {
  version: 1,
  onboarded: false,
  follows: [],
  theme: 'dark',
  colour: 'violet',
  motion: 'system',
  live: DEFAULT_LIVE_PREFERENCES,
  extraFeeds: false,
};

function load(): Preferences {
  const saved = storage.read<Partial<Preferences>>(KEY, {});
  return {
    ...DEFAULTS,
    ...saved,
    version: 1,
    colour: COLOUR_THEMES.some((theme) => theme.value === saved.colour) ? saved.colour! : DEFAULTS.colour,
    live: { ...DEFAULT_LIVE_PREFERENCES, ...saved.live, custom: { ...DEFAULT_LIVE_PREFERENCES.custom, ...saved.live?.custom } },
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
    updateLive: (patch: Partial<LivePreferences>) => preferencesStore.set((p) => ({ ...p, live: { ...p.live, ...patch } })),
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
    document.documentElement.dataset.colour = prefs.colour;
  }, [prefs.colour]);

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

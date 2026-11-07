import {
  ALL_SLOTS,
  DEFAULT_SELECTION_CONFIG,
  type SelectionConfig,
  type SlotId,
  type ViewerSelectionOptions,
} from '@sportlight/shared';
import type { LayoutId, LivePreferences, SwitchAnimation, SwitchPace } from './preferences';
import { Store, useStore } from './store';

/**
 * Session state for the live page that isn't a saved preference: the header lock and whether the
 * live table fills the sidebar. Kept outside React so it survives navigation.
 */
export interface LiveUiState {
  locked: boolean;
  tableExpanded: boolean;
  requestedFeedId?: string;
}

export const liveUi = new Store<LiveUiState>({ locked: false, tableExpanded: false });

const actions = {
  requestFeed: (requestedFeedId?: string) => liveUi.set((s) => ({ ...s, requestedFeedId })),
  setLocked: (locked: boolean) => liveUi.set((s) => ({ ...s, locked })),
  toggleLocked: () => liveUi.set((s) => ({ ...s, locked: !s.locked })),
  setTableExpanded: (tableExpanded: boolean) => liveUi.set((s) => ({ ...s, tableExpanded })),
};

export function useLiveUi() {
  return { ...useStore(liveUi), ...actions };
}

/** The live page registers how voice commands act on its windows; the header mic calls it. */
export interface VoiceReply {
  reply: string;
  /** False when nothing was done, so the mic can show example commands again. */
  ok: boolean;
  /** The autocorrected command, when it differs from what was heard. */
  understood?: string;
}
export interface VoiceHandler {
  run: (alternatives: string[]) => VoiceReply;
  examples: () => string[];
}
let voiceHandler: VoiceHandler | null = null;

export function setVoiceHandler(handler: VoiceHandler) {
  voiceHandler = handler;
  return () => {
    if (voiceHandler === handler) voiceHandler = null;
  };
}

export function runVoiceCommand(alternatives: string[]): VoiceReply {
  return voiceHandler ? voiceHandler.run(alternatives) : { reply: 'Voice commands work on the live page.', ok: false };
}

export function voiceCommandExamples(): string[] {
  return voiceHandler?.examples() ?? [];
}

// ---------------------------------------------------------------- layouts

export interface LayoutDef {
  id: LayoutId;
  name: string;
  description: string;
  /** Side windows this layout shows. */
  sideSlots: readonly SlotId[];
  /** Whether a live-feeds table takes the last sidebar block. */
  table: boolean;
  /** Whether the sidebar can be placed on either side. */
  sided: boolean;
}

export const LAYOUTS: readonly LayoutDef[] = [
  {
    id: 'theatre',
    name: 'Theatre',
    description: 'Wide main window with three windows beneath.',
    sideSlots: ['side-1', 'side-2', 'side-3'],
    table: false,
    sided: false,
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Main window with three side windows.',
    sideSlots: ['side-1', 'side-2', 'side-3'],
    table: false,
    sided: true,
  },
  {
    id: 'quad',
    name: 'Quad',
    description: 'Four equal windows. Audio follows the top-left one.',
    sideSlots: ['side-1', 'side-2', 'side-3'],
    table: false,
    sided: false,
  },
  {
    id: 'table',
    name: 'Details',
    description: 'Main window with three sidebar sections: live feed details and two side windows.',
    sideSlots: ['side-1', 'side-2'],
    table: true,
    sided: true,
  },
];

export function layoutDef(id: LayoutId): LayoutDef {
  return LAYOUTS.find((l) => l.id === id) ?? LAYOUTS[0]!;
}

/** Screen numbers (1 = main), used on the tiles and for the 1–4 keybinds. */
export function screenNumber(slot: SlotId): number {
  return ALL_SLOTS.indexOf(slot) + 1;
}

// ---------------------------------------------------------------- switching

export const PACES: ReadonlyArray<{ id: Exclude<SwitchPace, 'custom'>; name: string; hint: string }> = [
  { id: 'calm', name: 'Calm', hint: 'Fewer, bigger moments' },
  { id: 'balanced', name: 'Balanced', hint: 'The default rules' },
  { id: 'eager', name: 'Eager', hint: 'Chase every swing' },
];

/** The viewer's effective switching rules, layered on the server's defaults. */
export function effectiveSelectionConfig(server: SelectionConfig | null | undefined, live: LivePreferences): SelectionConfig {
  const base = server ?? DEFAULT_SELECTION_CONFIG;
  switch (live.pace) {
    case 'calm':
      return {
        ...base,
        minDisplayMs: base.minDisplayMs * 2,
        replaceMargin: Math.round(base.replaceMargin * 1.5),
        challengeMs: Math.round(base.challengeMs * 1.7),
      };
    case 'eager':
      return {
        ...base,
        minDisplayMs: Math.round(base.minDisplayMs / 2),
        replaceMargin: Math.max(3, Math.round(base.replaceMargin * 0.6)),
        challengeMs: Math.max(1000, Math.round(base.challengeMs * 0.6)),
      };
    case 'custom':
      return {
        ...base,
        minDisplayMs: live.custom.minDisplaySec * 1000,
        replaceMargin: live.custom.margin,
        challengeMs: live.custom.challengeSec * 1000,
      };
    default:
      return base;
  }
}

export function viewerOptions(live: LivePreferences, locked: boolean): ViewerSelectionOptions {
  return {
    sideSlots: live.beta3d ? ['side-1', 'side-2', 'side-3'] : layoutDef(live.layout).sideSlots,
    locked,
    countdownMs: live.countdownSec * 1000,
    mainPolicy: live.mainPolicy,
  };
}

// ---------------------------------------------------------------- animation

export const ANIMATIONS: ReadonlyArray<{ id: SwitchAnimation; name: string; description: string }> = [
  {
    id: 'spotlight',
    name: 'Spotlight',
    description: 'The new feed opens out of its intensity badge in a ring of light.',
  },
  {
    id: 'stinger',
    name: 'Stinger',
    description: 'A broadcast-style replay wipe sweeps the new feed in.',
  },
  {
    id: 'flip',
    name: 'Flip',
    description: 'Windows turn over like cards in 3D.',
  },
];

/** How long the incoming feed's reveal takes, per animation (reduced motion: a quick crossfade). */
export function revealMsFor(animation: SwitchAnimation, reduced: boolean): number {
  if (reduced) return 220;
  return animation === 'stinger' ? 900 : animation === 'flip' ? 820 : 760;
}

/** How long a feed takes to travel between windows (promotion / swaps). */
export function moveMsFor(animation: SwitchAnimation, reduced: boolean): number {
  if (reduced) return 1;
  return animation === 'flip' ? 640 : animation === 'stinger' ? 460 : 560;
}

import { create } from 'zustand';
import type { NavSection, ServerEvent } from '@orbit/contracts';
import { buildAccentRamp, presets, type PresetId } from '@orbit/ui-tokens';
import { useStore } from './store';

/** UI state for bot settings, app settings, the Tasks view and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark' | 'hc';
/** A named accent preset, or `custom` once the person picks their own accent. */
export type Preset = PresetId | 'custom';
export type BotSettingsTab = 'general' | 'skills' | 'memories' | 'routines';
export type AppSection = 'general' | 'appearance' | 'engine-auth' | 'computer' | 'permissions' | 'apps' | 'account';

/** Every section of the nav rail, in display order. */
export const NAV_SECTIONS: readonly NavSection[] = ['activity', 'chat', 'calendar', 'calls', 'files', 'computers', 'skills'];

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSection | null;
  view: 'chat' | 'tasks';
  theme: Theme;
  /** The named accent preset (Teams purple by default). */
  preset: Preset;
  /** A custom accent hex, when the person picked their own; null while a preset is in charge. */
  accentColor: string | null;
  /** Which section the left icon rail has selected. */
  navSection: NavSection;
  /** The 280px section panel next to the rail; ⌘B collapses it to nothing. */
  sectionPanelCollapsed: boolean;
  /** Bumped by server events (tasks, memories) so open views refetch. Keys: 'tasks', 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSection): void;
  closeAppSettings(): void;
  setView(v: 'chat' | 'tasks'): void;
  setTheme(t: Theme): void;
  setPreset(p: Preset): void;
  /** Write a custom accent ramp onto :root and remember the hex. */
  setAccentColor(hex: string | null): void;
  setNavSection(s: NavSection): void;
  toggleSectionPanel(): void;
  bump(key: string): void;
}

const LS_THEME = 'grokbot.theme';
const LS_PRESET = 'orbit_preset';
const LS_ACCENT = 'orbit_accent';
const ACCENT_VARS = ['--accent-100', '--accent-200', '--accent-300', '--accent-400', '--accent-500', '--accent-600', '--accent-700', '--accent-800'] as const;
const LS_NAV_SECTION = 'grokbot.navSection';
const LS_SECTION_PANEL = 'grokbot.sectionPanelCollapsed';
const readTheme = (): Theme => {
  try {
    const t = localStorage.getItem(LS_THEME);
    return t === 'light' || t === 'dark' || t === 'hc' ? t : 'system';
  } catch { return 'system'; }
};
const readPreset = (): Preset => {
  try {
    const p = localStorage.getItem(LS_PRESET);
    return presets.some((x) => x.id === p) ? (p as PresetId) : 'default';
  } catch { return 'default'; }
};
const readAccent = (): string | null => {
  try { return localStorage.getItem(LS_ACCENT); } catch { return null; }
};
const readNavSection = (): NavSection => {
  try {
    const s = localStorage.getItem(LS_NAV_SECTION);
    return NAV_SECTIONS.includes(s as NavSection) ? (s as NavSection) : 'chat';
  } catch { return 'chat'; }
};
const readSectionPanelCollapsed = (): boolean => {
  try { return localStorage.getItem(LS_SECTION_PANEL) === '1'; } catch { return false; }
};
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme) {
  const resolved = t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved === 'hc' ? 'dark' : resolved;
}

/** `default` is the base ramp in tokens.css, so it clears the attribute. */
export function applyPreset(p: Preset) {
  const root = document.documentElement;
  if (p === 'default' || p === 'custom') delete root.dataset.preset;
  else root.dataset.preset = p;
}

/** A custom accent overrides every preset stop with an inline ramp on :root. */
export function applyAccent(hex: string | null) {
  const style = document.documentElement.style;
  if (!hex) { for (const v of ACCENT_VARS) style.removeProperty(v); return; }
  const ramp = buildAccentRamp(hex);
  for (const [name, value] of Object.entries(ramp)) style.setProperty(name, value);
}

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: null,
  appSettings: null,
  view: 'chat',
  theme: readTheme(),
  preset: readAccent() ? 'custom' : readPreset(),
  accentColor: readAccent(),
  navSection: readNavSection(),
  sectionPanelCollapsed: readSectionPanelCollapsed(),
  versions: {},
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section = 'general') => set({ appSettings: section }),
  closeAppSettings: () => set({ appSettings: null }),
  setView: (view) => set({ view }),
  setTheme: (theme) => {
    lsSet(LS_THEME, theme);
    applyTheme(theme);
    set({ theme });
  },
  setPreset: (preset) => {
    lsSet(LS_PRESET, preset === 'custom' ? 'default' : preset);
    applyPreset(preset);
    // Choosing a named preset drops any custom ramp so the preset is what shows.
    if (preset !== 'custom') {
      try { localStorage.removeItem(LS_ACCENT); } catch { /* ignore */ }
      applyAccent(null);
      set({ preset, accentColor: null });
    } else set({ preset });
  },
  setAccentColor: (hex) => {
    lsSet(LS_ACCENT, hex ?? '');
    applyAccent(hex);
    set({ accentColor: hex, preset: hex ? 'custom' : 'default' });
  },
  setNavSection: (navSection) => {
    lsSet(LS_NAV_SECTION, navSection);
    // Chat and Tasks share one section; leaving it resets the Tasks tab so coming back lands on the transcript.
    if (navSection === 'chat' && get().view !== 'chat') set({ navSection, view: 'chat' });
    else set({ navSection });
  },
  toggleSectionPanel: () => {
    const sectionPanelCollapsed = !get().sectionPanelCollapsed;
    lsSet(LS_SECTION_PANEL, sectionPanelCollapsed ? '1' : '0');
    set({ sectionPanelCollapsed });
  },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
applyPreset(readAccent() ? 'custom' : readPreset());
applyAccent(readAccent());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

// store.ts forwards events it doesn't handle itself as a DOM event.
window.addEventListener('grokbot:event', (e) => {
  const ev = (e as CustomEvent<ServerEvent>).detail;
  const { bump } = useConfigUI.getState();
  if (ev.type === 'tasks') { bump('tasks'); bump(`tasks:${ev.botId}`); }
  if (ev.type === 'memories') bump(`memories:${ev.botId}`);
});

// Picking a bot anywhere (sidebar, search) goes back to its chat.
useStore.subscribe((s, prev) => {
  if (s.selectedBotId !== prev.selectedBotId && useConfigUI.getState().view !== 'chat') useConfigUI.getState().setView('chat');
});

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);

/**
 * Orbit's design tokens — Fluent 2 (Teams) system.
 *
 * `tokens.css` (next to this file) is the source of truth for the web and desktop
 * renderers. The constants below mirror the same values for consumers that cannot
 * read CSS custom properties — React Native, Electron's main process, tests.
 *
 * When you change a value here, change it in tokens.css too (they are kept in sync
 * by eye; the CSS file is what production web renders).
 */

export type ThemeMode = 'light' | 'dark' | 'hc';

/** Semantic colours, aliased onto the CSS variables the web app renders. */
export const colorVars = {
  bg: '--color-bg-stage',
  bgCanvas: '--color-bg-canvas',
  bgChrome: '--color-bg-canvas',
  bgNav: '--color-bg-nav',
  bgSidebar: '--color-bg-nav',
  bgElevated: '--color-bg-elevated',
  bgSubtle: '--color-bg-subtle',
  bgHover: '--color-bg-nav-hover',
  fg: '--color-fg-default',
  fgSecondary: '--color-fg-subtle',
  fgTertiary: '--color-fg-muted',
  fgOnAccent: '--color-fg-on-accent',
  card: '--color-bg-elevated',
  muted: '--color-fg-subtle',
  border: '--color-border-default',
  borderTertiary: '--color-border-subtle',
  accent: '--accent-500',
  accentHover: '--accent-600',
  onAccent: '--color-fg-on-accent',
  destructive: '--color-danger',
  destructiveBg: '--color-danger-bg',
  success: '--color-success',
  successBg: '--color-success-bg',
  warn: '--color-warn',
  warnBg: '--color-warn-bg',
  info: '--color-info',
  infoBg: '--color-info-bg',
  focus: '--color-border-focus',
  bubbleUser: '--color-bubble-user',
  bubbleAgent: '--color-bubble-agent',
  navRailBg: '--nav-rail-bg',
  navRailSelected: '--nav-rail-icon-selected',
  navRailIcon: '--nav-rail-icon',
  navRailIconSelected: '--nav-rail-icon-selected',
  sectionPanelBg: '--section-panel-bg',
  sectionPanelBorder: '--section-panel-border',
} as const;

export type ColorToken = keyof typeof colorVars;

/** A CSS `var()` reference for a token. */
export function cssVar(token: ColorToken): string {
  return `var(${colorVars[token]})`;
}

const ACCENT_LIGHT = {
  accent: '#5B5FC7', accentHover: '#4D51B4', onAccent: '#FFFFFF',
} as const;

/**
 * Concrete values, for platforms without CSS variables (React Native, native windows).
 * Light values are the Fluent 2 base; dark and hc mirror their theme files.
 */
export const palette: Record<ThemeMode, Record<ColorToken, string>> = {
  light: {
    bg: '#FFFFFF',
    bgCanvas: '#F5F5F5',
    bgChrome: '#F5F5F5',
    bgNav: '#E8EBEF',
    bgSidebar: '#E8EBEF',
    bgElevated: '#FFFFFF',
    bgSubtle: '#00000008',
    bgHover: '#DEE1E5',
    fg: '#242424',
    fgSecondary: '#616161',
    fgTertiary: '#8A8A8A',
    fgOnAccent: '#FFFFFF',
    card: '#FFFFFF',
    muted: '#616161',
    border: '#D1D1D1',
    borderTertiary: '#E0E0E0',
    accent: ACCENT_LIGHT.accent,
    accentHover: ACCENT_LIGHT.accentHover,
    onAccent: ACCENT_LIGHT.onAccent,
    destructive: '#C4262E',
    destructiveBg: '#FDE7E9',
    success: '#107C41',
    successBg: '#DFF6DD',
    warn: '#835B00',
    warnBg: '#FFF4CE',
    info: '#0078D4',
    infoBg: '#DEECF9',
    focus: ACCENT_LIGHT.accent,
    bubbleUser: '#5B5FC7',
    bubbleAgent: '#0000000D',
    navRailBg: '#1F1F1F',
    navRailSelected: '#FFFFFF',
    navRailIcon: '#FFFFFFB8',
    navRailIconSelected: '#FFFFFF',
    sectionPanelBg: '#E8EBEF',
    sectionPanelBorder: '#E0E0E0',
  },
  dark: {
    bg: '#1E1E1E',
    bgCanvas: '#111111',
    bgChrome: '#111111',
    bgNav: '#1A1A1A',
    bgSidebar: '#1A1A1A',
    bgElevated: '#2A2A2A',
    bgSubtle: '#FFFFFF06',
    bgHover: '#252525',
    fg: '#E8E8E8',
    fgSecondary: '#ABABAB',
    fgTertiary: '#767676',
    fgOnAccent: '#FFFFFF',
    card: '#2A2A2A',
    muted: '#ABABAB',
    border: '#383838',
    borderTertiary: '#2D2D2D',
    accent: '#8080D7',
    accentHover: '#9494DD',
    onAccent: '#FFFFFF',
    destructive: '#EF6868',
    destructiveBg: '#2D0A0A',
    success: '#54B054',
    successBg: '#0F2A0F',
    warn: '#E5C365',
    warnBg: '#2A1E00',
    info: '#4CA6F7',
    infoBg: '#001833',
    focus: '#7777D3',
    bubbleUser: '#8080D7',
    bubbleAgent: '#FFFFFF0F',
    navRailBg: '#111111',
    navRailSelected: '#FFFFFF',
    navRailIcon: '#FFFFFFAD',
    navRailIconSelected: '#FFFFFF',
    sectionPanelBg: '#1A1A1A',
    sectionPanelBorder: '#2D2D2D',
  },
  hc: {
    bg: '#000000',
    bgCanvas: '#000000',
    bgChrome: '#000000',
    bgNav: '#000000',
    bgSidebar: '#000000',
    bgElevated: '#000000',
    bgSubtle: '#000000',
    bgHover: '#1AEBFF',
    fg: '#FFFFFF',
    fgSecondary: '#FFFFFF',
    fgTertiary: '#A6A6A6',
    fgOnAccent: '#000000',
    card: '#000000',
    muted: '#FFFFFF',
    border: '#FFFFFF',
    borderTertiary: '#FFFFFF',
    accent: '#FFFF00',
    accentHover: '#FFE500',
    onAccent: '#000000',
    destructive: '#FF0000',
    destructiveBg: '#000000',
    success: '#00FF00',
    successBg: '#000000',
    warn: '#FFFF00',
    warnBg: '#000000',
    info: '#1AEBFF',
    infoBg: '#000000',
    focus: '#FFFF00',
    bubbleUser: '#FFFF00',
    bubbleAgent: '#000000',
    navRailBg: '#000000',
    navRailSelected: '#FFFFFF',
    navRailIcon: '#A6A6A6',
    navRailIconSelected: '#FFFFFF',
    sectionPanelBg: '#000000',
    sectionPanelBorder: '#FFFFFF',
  },
};

/** The preset themes. `default` is the base purple ramp in tokens.css. */
export const presets = [
  { id: 'default', label: 'Orbit Purple', accent: '#5B5FC7', navRail: '#1F1F1F' },
  { id: 'midnight', label: 'Midnight Blue', accent: '#0078D4', navRail: '#032551' },
  { id: 'ocean', label: 'Ocean Teal', accent: '#0097A7', navRail: '#003D47' },
  { id: 'forest', label: 'Forest Green', accent: '#107C41', navRail: '#052612' },
  { id: 'rose', label: 'Rose', accent: '#E03A52', navRail: '#2D0611' },
  { id: 'slate', label: 'Slate', accent: '#5C6670', navRail: '#1A2026' },
  { id: 'amber', label: 'Amber', accent: '#C8880B', navRail: '#1F1600' },
] as const;

export type PresetId = (typeof presets)[number]['id'];

/** Metrics for the app shell: the icon rail, the section panel and the details panel. */
export const layout = {
  navRailWidth: 48,
  navRailItemHeight: 52,
  sectionPanelWidth: 280,
  detailsPanelWidth: 360,
  conversationHeaderHeight: 48,
  sectionPanelHeaderHeight: 48,
  chatRowHeight: 52,
} as const;

/** CSS variables that carry the same metrics. */
export const layoutVars = {
  navRailWidth: '--nav-rail-width',
  sectionPanelWidth: '--section-panel-width',
  detailsPanelWidth: '--details-panel-width',
} as const;

/** The colours a bot avatar can have, shared by web and mobile. */
export const botColors = {
  black: '#1C1C1C',
  brown: '#A06B39',
  red: '#FB2B3E',
  orange: '#FD690F',
  yellow: '#F59312',
  green: '#14C16F',
  cyan: '#13B7A2',
  blue: '#1E86FC',
  violet: '#8F59F9',
  magenta: '#F93498',
  gray: '#999999',
} as const;

/** 4pt spacing scale. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

/** Fluent 2 radius tiers. Cards use `lg`, buttons and inputs `sm`/`md`. */
export const radii = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  card: 12,
  full: 9999,
} as const;

/** Fluent 2 type ramp (px). */
export const fontSizes = {
  caption: 12,
  sm: 13,
  base: 14,
  message: 16,
  subtitle: 18,
  lg: 18,
  title: 20,
} as const;

export const lineHeights = {
  caption: 16,
  sm: 20,
  base: 20,
  message: 22,
  subtitle: 24,
  lg: 24,
  title: 28,
} as const;

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
} as const;

export const fonts = {
  sans: '"Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export { buildAccentRamp, hexToHsl, hslToHex, type AccentRamp } from './accentRamp.js';

/** Everything above, in one object, for consumers that want a single import. */
export const tokens = {
  colorVars, palette, presets, layout, layoutVars, botColors,
  space, radii, fontSizes, lineHeights, fontWeights, fonts,
} as const;

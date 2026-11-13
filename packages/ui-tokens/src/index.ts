/**
 * Orbit's design tokens.
 *
 * `tokens.css` (next to this file) is the source of truth for the web and desktop
 * renderers. The constants below mirror the same values for consumers that cannot
 * read CSS custom properties — React Native, Electron's main process, tests.
 *
 * When you change a value here, change it in tokens.css too (they are kept in sync
 * by eye; the CSS file is what production web renders).
 */

export type ThemeMode = 'light' | 'dark';

/** Semantic colours, aliased onto the CSS variables the web app already uses. */
export const colorVars = {
  bg: '--color-bg-pane',
  bgChrome: '--color-bg-chrome',
  bgSidebar: '--color-bg-sidebar',
  bgElevated: '--color-bg-elevated',
  bgSubtle: '--color-bg-subtle',
  bgHover: '--color-bg-hover',
  fg: '--color-text-primary',
  fgSecondary: '--color-text-secondary',
  fgTertiary: '--color-text-tertiary',
  card: '--color-bg-elevated',
  muted: '--color-text-secondary',
  border: '--color-border-secondary',
  borderTertiary: '--color-border-tertiary',
  accent: '--color-primary',
  accentHover: '--color-bg-primary-hover',
  onAccent: '--color-on-primary',
  destructive: '--color-danger',
  destructiveBg: '--color-danger-bg',
  success: '--color-success',
  successBg: '--color-success-bg',
  warn: '--color-warn',
  warnBg: '--color-warn-bg',
  focus: '--color-border-focus',
  bubbleUser: '--color-bubble-user',
  bubbleAgent: '--color-bubble-agent',
} as const;

export type ColorToken = keyof typeof colorVars;

/** A CSS `var()` reference for a token. */
export function cssVar(token: ColorToken): string {
  return `var(${colorVars[token]})`;
}

/** Concrete values, for platforms without CSS variables (React Native, native windows). */
export const palette: Record<ThemeMode, Record<ColorToken, string>> = {
  light: {
    bg: '#FFFFFF',
    bgChrome: '#FCFCFC',
    bgSidebar: '#F5F5F5',
    bgElevated: '#FFFFFF',
    bgSubtle: '#1C1C1C08',
    bgHover: '#1C1C1C0F',
    fg: '#1C1C1C',
    fgSecondary: '#1C1C1CAD',
    fgTertiary: '#1C1C1C8F',
    card: '#FFFFFF',
    muted: '#1C1C1CAD',
    border: '#1C1C1C1F',
    borderTertiary: '#1C1C1C14',
    accent: '#1C1C1C',
    accentHover: '#363636',
    onAccent: '#FCFCFC',
    destructive: '#E72E3B',
    destructiveBg: '#FB2B3E14',
    success: '#10AB61',
    successBg: '#14C16F17',
    warn: '#DA830E',
    warnBg: '#F5931217',
    focus: '#1E86FC',
    bubbleUser: '#1C1C1C',
    bubbleAgent: '#1C1C1C0F',
  },
  dark: {
    bg: '#161616',
    bgChrome: '#121212',
    bgSidebar: '#0E0E0E',
    bgElevated: '#1F1F1F',
    bgSubtle: '#F5F5F505',
    bgHover: '#F5F5F50F',
    fg: '#F5F5F5',
    fgSecondary: '#F5F5F5A8',
    fgTertiary: '#F5F5F58A',
    card: '#1F1F1F',
    muted: '#F5F5F5A8',
    border: '#F5F5F51A',
    borderTertiary: '#F5F5F50F',
    accent: '#F5F5F5',
    accentHover: '#DBDBDB',
    onAccent: '#121212',
    destructive: '#CF2B35',
    destructiveBg: '#FC2C3E1F',
    success: '#0E9F5A',
    successBg: '#14C3701F',
    warn: '#C8770C',
    warnBg: '#F694121F',
    focus: '#1884FC',
    bubbleUser: '#F5F5F52E',
    bubbleAgent: '#F5F5F50F',
  },
};

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

export const radii = {
  sm: 8,
  md: 12,
  bubble: 18,
  composer: 22,
  card: 24,
  full: 9999,
} as const;

export const fontSizes = {
  xs: 12,
  sm: 13,
  base: 14,
  message: 15,
  lg: 17,
} as const;

export const fontWeights = {
  regular: '425',
  medium: '500',
  semibold: '600',
} as const;

export const fonts = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/** Everything above, in one object, for consumers that want a single import. */
export const tokens = { colorVars, palette, botColors, space, radii, fontSizes, fontWeights, fonts } as const;

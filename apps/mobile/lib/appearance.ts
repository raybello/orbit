import { Platform, PlatformColor, type ColorSchemeName, type ColorValue } from 'react-native';
import { palette as orbitPalette, type ColorToken, type ThemeMode } from '@orbit/ui-tokens';

/**
 * Orbit's colours on a phone.
 *
 * The semantic tokens come straight from @orbit/ui-tokens (the same values the web app renders), and
 * for the surfaces the OS draws around them — window background, label text, separators — iOS gets
 * its real dynamic system colours so light/dark switches without a re-render. Android keeps the token
 * values: PlatformColor there wants theme attributes, and a wrong attribute name crashes the view
 * instead of falling back, so the safer choice is the palette we control.
 */

export type { ColorToken, ThemeMode };

export const palette = orbitPalette;

export function modeFor(scheme: ColorSchemeName): ThemeMode {
  return scheme === 'dark' ? 'dark' : 'light';
}

export interface ChromeColors {
  /** The window behind everything — behind the tab bar and the keyboard. */
  background: ColorValue;
  /** Primary label colour for navigation chrome. */
  label: ColorValue;
  /** Hairline between cells and sections. */
  separator: ColorValue;
  /** Fill for grouped list backgrounds. */
  groupedBackground: ColorValue;
}

export function chromeFor(mode: ThemeMode): ChromeColors {
  const tokens = palette[mode];
  return {
    background: iosColor('systemBackground') ?? tokens.bg,
    label: iosColor('label') ?? tokens.fg,
    separator: iosColor('separator') ?? tokens.border,
    groupedBackground: iosColor('systemGroupedBackground') ?? tokens.bgSidebar,
  };
}

/** iOS-only: returns undefined elsewhere so the caller can fall back to a token. */
function iosColor(name: string): ColorValue | undefined {
  return Platform.OS === 'ios' ? PlatformColor(name) : undefined;
}

/** Mono spacing for code blocks and the composer hint, per platform. */
export const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

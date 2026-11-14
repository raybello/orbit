import { useColorScheme } from 'react-native';
import {
  botColors,
  fontSizes,
  fontWeights,
  lineHeights,
  radii,
  space,
  type ColorToken,
  type ThemeMode,
} from '@orbit/ui-tokens';
import { chromeFor, modeFor, monoFont, palette, type ChromeColors } from './appearance';

export interface MobileTokens {
  mode: ThemeMode;
  dark: boolean;
  /** Semantic colour per token, resolved for the current appearance. */
  colors: Record<ColorToken, string>;
  /** Native chrome, which follows the system appearance on iOS. */
  chrome: ChromeColors;
  bots: typeof botColors;
  space: typeof space;
  radii: typeof radii;
  fontSizes: typeof fontSizes;
  fontWeights: typeof fontWeights;
  lineHeights: typeof lineHeights;
  mono: string;
  /** RN's thinnest line, scaled by the device. */
  hairline: number;
}

/** The design tokens, adapted to React Native's colour model and the current appearance. */
export function useMobileTokens(): MobileTokens {
  const scheme = useColorScheme();
  const mode = modeFor(scheme);
  return {
    mode,
    dark: mode === 'dark',
    colors: palette[mode],
    chrome: chromeFor(mode),
    bots: botColors,
    space,
    radii,
    fontSizes,
    fontWeights,
    lineHeights,
    mono: monoFont,
    hairline: 0.5,
  };
}

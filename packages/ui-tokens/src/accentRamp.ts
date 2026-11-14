/**
 * Build a full Fluent accent ramp (100…800) from a single hex colour.
 *
 * The picker hands us one colour — the "brand" colour — and everything else is
 * derived: keep the hue and saturation, walk the lightness down the same stops
 * the preset ramps use, and clamp sRGB at the ends. Written without dependencies
 * so the mobile app can import it too.
 */

export type AccentRamp = Record<'--accent-100' | '--accent-200' | '--accent-300' | '--accent-400' | '--accent-500' | '--accent-600' | '--accent-700' | '--accent-800', string>;

/** Lightness stops, index 4 (0.50) is the base colour. */
const LIGHT_STOPS = [0.92, 0.84, 0.70, 0.60, 0.50, 0.42, 0.34, 0.26];

interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(n)) return { h: 0, s: 0, l: 0.5 };
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v + m)) * 255).toString(16).padStart(2, '0');
  return `#${to(r1)}${to(g1)}${to(b1)}`.toUpperCase();
}

/** The full ramp for `hex`, keyed by the CSS custom properties it writes. */
export function buildAccentRamp(hex: string): AccentRamp {
  const { h, s } = hexToHsl(hex);
  // Saturation is eased at the pale end so 100/200 stay tints rather than pastels.
  const stops = LIGHT_STOPS.map((l, i) => hslToHex({ h, s: i < 2 ? s * 0.85 : i > 5 ? s * 0.95 : s, l }));
  return {
    '--accent-100': stops[0],
    '--accent-200': stops[1],
    '--accent-300': stops[2],
    '--accent-400': stops[3],
    '--accent-500': stops[4],
    '--accent-600': stops[5],
    '--accent-700': stops[6],
    '--accent-800': stops[7],
  };
}

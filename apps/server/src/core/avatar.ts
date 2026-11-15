import type { AvatarColor, AvatarShape } from '@orbit/contracts';

/**
 * The look of a new bot: a shape and a colour picked from a fixed palette.
 *
 * Moved out of routes.ts unchanged. Two rules are load-bearing and easy to lose:
 *  - an explicit shape/colour wins only when it is one the palette actually has;
 *  - the hash fallback uses a narrower palette than the palette itself: the first 13 shapes and
 *    every colour except black. Black is the primary bot's colour, and the newer shapes were added
 *    later, so hash-picked newcomers stay in the original look.
 */

export const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
export const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

/** The shapes an automatic (hash-picked) avatar may use. */
export const HASH_SHAPES = SHAPES.slice(0, 13);
/** The colours an automatic (hash-picked) avatar may use: everything but the primary bot's black. */
export const HASH_COLORS = COLORS.filter((c) => c !== 'black');

/** FNV-1a over the id, so a given bot always gets the same look. */
export function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

export interface Avatar {
  shape: AvatarShape;
  color: AvatarColor;
}

/**
 * The avatar rule: a requested value that the palette contains wins; anything else falls back to the
 * id's hash. Shape and colour are decided independently, both from the same id.
 */
export function pickAvatar(botId: string, requestedShape?: string, requestedColor?: string): Avatar {
  const shape = SHAPES.includes(requestedShape as AvatarShape) ? (requestedShape as AvatarShape) : hashPick(botId, HASH_SHAPES);
  const color = COLORS.includes(requestedColor as AvatarColor) ? (requestedColor as AvatarColor) : hashPick(botId, HASH_COLORS);
  return { shape, color };
}

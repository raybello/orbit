import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { AvatarShape, Bot } from '@orbit/contracts';
import { botColors } from '@orbit/ui-tokens';
import { SHAPES, type ShapeDef } from '../lib/avatar-shapes';

/** Shapes without their own artwork fall back to the closest silhouette we have (same map as the web app). */
const FALLBACK: Partial<Record<AvatarShape, string>> = {
  bean: 'teardrop',
  squircle: 'square',
  capsule: 'tablet',
  cylinder: 'tablet',
  gem: 'hex',
  crystal: 'hex',
  shield: 'house',
  dome: 'house',
  arch: 'house',
  leaf: 'teardrop',
};

/** The design draws every shape inside a 55.2 box but shows it in a 36 box, so it bleeds over the slot. */
const OVERDRAW = 55.2 / 36;

export function shapeDef(shape: string): ShapeDef {
  return SHAPES[shape] ?? SHAPES[FALLBACK[shape as AvatarShape] ?? 'blob'] ?? SHAPES.blob;
}

export function botColor(color: string): string {
  return (botColors as Record<string, string>)[color] ?? botColors.gray;
}

export interface BotAvatarProps {
  shape: AvatarShape | string;
  color: string;
  /** Slot size in px. */
  size: number;
  /** Light ring around the silhouette, used when the avatar sits on a coloured surface. */
  ring?: boolean;
}

export function BotAvatar({ shape, color, size, ring = false }: BotAvatarProps) {
  const def = shapeDef(shape);
  const draw = size * OVERDRAW;
  // Stroke widths are expressed in viewBox units, so convert the drawn size back to them.
  const viewBoxWidth = Number(def.viewBox.split(/\s+/)[2]) || 55.2;
  const unitsPerPx = viewBoxWidth / draw;

  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', overflow: 'visible' }}
      pointerEvents="none"
    >
      <Svg width={draw} height={draw} viewBox={def.viewBox} style={{ overflow: 'visible' }}>
        {ring ? (
          <Path
            d={def.outline}
            fill="transparent"
            stroke="#FFFFFF88"
            strokeWidth={unitsPerPx * 3}
            strokeLinejoin="round"
          />
        ) : null}
        <Path d={def.outline} fill="#FFFFFF" />
        <Path d={def.d} fill={botColor(color)} fillRule="evenodd" />
      </Svg>
    </View>
  );
}

export function BotAvatarFor({
  bot,
  size,
  ring,
}: {
  bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'>;
  size: number;
  ring?: boolean;
}) {
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} ring={ring} />;
}

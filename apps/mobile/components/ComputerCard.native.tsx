import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { Bot, BotComputerStatus } from '@orbit/contracts';
import { BotAvatarFor } from './bot-avatar';
import { useMobileTokens, type MobileTokens } from '../lib/native';

/**
 * One bot's computer as a card: whose it is, whether it is awake, and the way into the live screen.
 *
 * There is no live preview inside the card on purpose. The full-screen viewer opens a noVNC relay
 * connection per mount, so a list of previews would take one of the computer's limited screens for
 * every bot merely by being looked at.
 */

const STATUS_LABEL: Record<BotComputerStatus['status'], string> = {
  awake: 'Awake',
  sleeping: 'Sleeping',
  starting: 'Starting',
  unknown: 'Unknown',
};

const KIND_LABEL: Record<BotComputerStatus['kind'], string> = {
  docker: 'Docker',
  orgo: 'Orgo',
  none: '',
};

function statusColor(status: BotComputerStatus['status'], tokens: MobileTokens): string {
  if (status === 'awake') return tokens.colors.success;
  if (status === 'starting') return tokens.colors.warn;
  if (status === 'sleeping') return tokens.colors.fgTertiary;
  return tokens.colors.fgTertiary;
}

export type ComputerCardProps = {
  computer: BotComputerStatus;
  /** The roster row, for the avatar. /api/computers can be fresher than the roster, so it is optional. */
  bot?: Bot;
  onOpen: (botId: string) => void;
};

export function ComputerCard({ computer, bot, onOpen }: ComputerCardProps) {
  const tokens = useMobileTokens();
  const status = STATUS_LABEL[computer.status] ?? 'Unknown';
  const canOpen = computer.vncAvailable;
  const kind = KIND_LABEL[computer.kind] ?? '';
  const avatar: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> = bot ?? {
    avatarShape: 'blob',
    avatarColor: 'gray',
    name: computer.botName,
  };

  return (
    <View
      style={{
        backgroundColor: tokens.colors.bgElevated,
        borderRadius: tokens.radii.card,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: tokens.colors.border,
        padding: tokens.space.lg,
        gap: tokens.space.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.md }}>
        <BotAvatarFor bot={avatar} size={32} />
        <Text numberOfLines={1} style={{ flex: 1, color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>
          {computer.botName}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: tokens.space.xs,
            paddingHorizontal: tokens.space.sm,
            paddingVertical: 2,
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.bgSubtle,
          }}
        >
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor(computer.status, tokens) }} />
          <Text style={{ color: tokens.colors.fgSecondary, fontSize: 11 }}>{status}</Text>
        </View>
      </View>

      <Pressable
        onPress={() => onOpen(computer.botId)}
        disabled={!canOpen}
        accessibilityRole="button"
        accessibilityLabel={canOpen ? `Open ${computer.botName}'s computer` : `${computer.botName} has no screen`}
        style={({ pressed }) => ({
          height: 96,
          borderRadius: tokens.radii.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.colors.border,
          backgroundColor: pressed ? tokens.colors.bgHover : tokens.colors.bgSubtle,
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.space.xs,
          opacity: canOpen ? 1 : 0.6,
        })}
      >
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
          <Path
            d="M3.5 5.5h17v10h-17zM9 19.5h6M12 15.5v4"
            stroke={tokens.colors.fgTertiary}
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>
          {canOpen ? (computer.status === 'awake' ? 'Screen ready' : `Screen ${status.toLowerCase()}`) : 'No screen'}
        </Text>
        {computer.isRunning ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: tokens.space.xs,
              paddingHorizontal: tokens.space.sm,
              paddingVertical: 1,
              borderRadius: tokens.radii.full,
              backgroundColor: tokens.colors.successBg,
            }}
          >
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.colors.success }} />
            <Text style={{ color: tokens.colors.success, fontSize: 10, fontWeight: '600' }}>Working</Text>
          </View>
        ) : null}
      </Pressable>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
        <Text style={{ flex: 1, color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{kind}</Text>
        <Pressable
          onPress={() => onOpen(computer.botId)}
          disabled={!canOpen}
          accessibilityRole="button"
          style={({ pressed }) => ({
            paddingHorizontal: tokens.space.lg,
            paddingVertical: tokens.space.sm,
            borderRadius: tokens.radii.full,
            backgroundColor: canOpen ? (pressed ? tokens.colors.accentHover : tokens.colors.accent) : tokens.colors.bgSubtle,
          })}
        >
          <Text
            style={{
              color: canOpen ? tokens.colors.onAccent : tokens.colors.fgTertiary,
              fontSize: tokens.fontSizes.sm,
              fontWeight: '600',
            }}
          >
            {canOpen ? 'Open' : 'No screen'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

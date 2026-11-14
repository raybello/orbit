import { useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../../components/bot-avatar';
import { timeAgo } from '../../lib/format';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useBotsQuery } from '../../lib/queries';
import { sortBots, useOrbitStore } from '../../lib/store';

/** The roster: what each bot is for, and the way into its screen. */
export default function BotsScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bots = useOrbitStore((s) => s.bots);
  const live = useOrbitStore((s) => s.live);
  const { isLoading, refetch, isRefetching } = useBotsQuery();
  const items = useMemo(() => sortBots(bots), [bots]);

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      <View style={{ paddingTop: insets.top + tokens.space.sm, paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.sm }}>
        <Text style={{ color: tokens.colors.fg, fontSize: 30, fontWeight: '600', letterSpacing: -0.5 }}>Bots</Text>
      </View>

      {isLoading && !items.length ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={tokens.colors.fgSecondary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(bot) => bot.id}
          contentContainerStyle={{ padding: tokens.space.xl, paddingTop: tokens.space.sm, gap: tokens.space.md, paddingBottom: insets.bottom + tokens.space.xxl }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={tokens.colors.fgSecondary} />
          }
          ListEmptyComponent={
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, textAlign: 'center', marginTop: tokens.space.xxxl }}>
              No bots on this server yet.
            </Text>
          }
          renderItem={({ item }) => (
            <BotCard
              bot={item}
              tokens={tokens}
              running={Boolean(live[item.id]?.isRunning)}
              caption={live[item.id]?.activity?.kind ?? null}
            />
          )}
        />
      )}
    </View>
  );
}

function BotCard({ bot, tokens, running, caption }: { bot: Bot; tokens: MobileTokens; running: boolean; caption: string | null }) {
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
      <View style={{ flexDirection: 'row', gap: tokens.space.md, alignItems: 'center' }}>
        <BotAvatarFor bot={bot} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
            <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '600' }} numberOfLines={1}>
              {bot.name}
            </Text>
            {bot.kind === 'room' ? <Chip tokens={tokens} label="Room" /> : null}
            {bot.isPrimary ? <Chip tokens={tokens} label="Primary" /> : null}
          </View>
          <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>
            {bot.label || (bot.mode === 'personal' ? 'Personal' : 'Teammate')}
            {bot.lastActivityAt ? ` · ${timeAgo(bot.lastActivityAt)}` : ''}
          </Text>
        </View>
      </View>

      {bot.description ? (
        <Text numberOfLines={3} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 19 }}>
          {bot.description}
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
        {running ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.xxs }}>
            <ActivityIndicator size="small" color={tokens.colors.success} />
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>{caption ?? 'Working…'}</Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable
          onPress={() => router.push(`/computer/${bot.id}`)}
          style={{
            paddingHorizontal: tokens.space.lg,
            paddingVertical: tokens.space.sm,
            borderRadius: tokens.radii.full,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: tokens.colors.border,
          }}
        >
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>Screen</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push(`/thread/${bot.id}`)}
          style={{
            paddingHorizontal: tokens.space.lg,
            paddingVertical: tokens.space.sm,
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.accent,
          }}
        >
          <Text style={{ color: tokens.colors.onAccent, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>Chat</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Chip({ tokens, label }: { tokens: MobileTokens; label: string }) {
  return (
    <View style={{ paddingHorizontal: tokens.space.sm, paddingVertical: 1, borderRadius: tokens.radii.full, backgroundColor: tokens.colors.bgSubtle }}>
      <Text style={{ color: tokens.colors.fgTertiary, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</Text>
    </View>
  );
}

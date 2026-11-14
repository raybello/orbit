import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../../components/bot-avatar';
import { timeAgo, unreadLabel } from '../../lib/format';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useBotsQuery, useMarkRead } from '../../lib/queries';
import { sortBots, useOrbitStore } from '../../lib/store';

/** The chat list: every bot, the one that spoke last first, with its unread count. */
export default function ChatsScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bots = useOrbitStore((s) => s.bots);
  const live = useOrbitStore((s) => s.live);
  const markRead = useMarkRead();
  const { isLoading, isError, error, refetch, isRefetching } = useBotsQuery();

  const items = useMemo(() => sortBots(bots), [bots]);

  const openBot = useCallback((bot: Bot) => {
    router.push(`/thread/${bot.id}`);
  }, []);

  /** Long press is the phone-native way to act on a row without opening it. */
  const showActions = useCallback(
    (bot: Bot) => {
      Alert.alert(bot.name, bot.lastPreview ?? 'No messages yet.', [
        ...(bot.unread > 0 ? [{ text: 'Mark as read', onPress: () => markRead.mutate(bot.id) }] : []),
        { text: 'Open computer', onPress: () => router.push(`/computer/${bot.id}`) },
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    },
    [markRead],
  );

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      <View style={{ paddingTop: insets.top + tokens.space.sm, paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Text style={{ color: tokens.colors.fg, fontSize: 30, fontWeight: '600', letterSpacing: -0.5 }}>Chats</Text>
          <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm }}>
            {items.length ? `${items.length} bot${items.length === 1 ? '' : 's'}` : ''}
          </Text>
        </View>
      </View>

      {isLoading && !items.length ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={tokens.colors.fgSecondary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(bot) => bot.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + tokens.space.xxl }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={tokens.colors.fgSecondary} />
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: tokens.colors.borderTertiary, marginLeft: 72 }} />
          )}
          ListEmptyComponent={<EmptyState tokens={tokens} error={isError ? (error as Error).message : null} />}
          renderItem={({ item }) => (
            <ChatRow
              bot={item}
              tokens={tokens}
              running={Boolean(live[item.id]?.isRunning)}
              onPress={() => openBot(item)}
              onLongPress={() => showActions(item)}
            />
          )}
        />
      )}
    </View>
  );
}

function ChatRow({
  bot,
  tokens,
  running,
  onPress,
  onLongPress,
}: {
  bot: Bot;
  tokens: MobileTokens;
  running: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const preview = bot.lastPreview?.trim() || 'No messages yet';
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens.space.md,
        paddingHorizontal: tokens.space.xl,
        paddingVertical: tokens.space.md,
        backgroundColor: pressed ? tokens.colors.bgHover : 'transparent',
      })}
    >
      <View>
        <BotAvatarFor bot={bot} size={44} />
        {running ? (
          <View
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: tokens.colors.success,
              borderWidth: 2,
              borderColor: tokens.colors.bg,
            }}
          />
        ) : null}
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '500' }}>
          {bot.name}
        </Text>
        <Text numberOfLines={2} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 18 }}>
          {preview}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: tokens.space.xs, minWidth: 44 }}>
        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.xs }}>
          {bot.lastActivityAt ? timeAgo(bot.lastActivityAt) : ''}
        </Text>
        {bot.unread > 0 ? (
          <View
            style={{
              minWidth: 20,
              height: 20,
              borderRadius: 10,
              paddingHorizontal: 5,
              backgroundColor: tokens.colors.accent,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: tokens.colors.onAccent, fontSize: 11, fontWeight: '600' }}>{unreadLabel(bot.unread)}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function EmptyState({ tokens, error }: { tokens: MobileTokens; error: string | null }) {
  return (
    <View style={{ padding: tokens.space.xxl, gap: tokens.space.sm, alignItems: 'center', marginTop: tokens.space.xxxl }}>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '500' }}>
        {error ? 'Could not reach the server' : 'No bots yet'}
      </Text>
      <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, textAlign: 'center', lineHeight: 19 }}>
        {error ??
          'Bots are created on the web app. Once one exists it shows up here, with its screen and its chat.'}
      </Text>
      {error ? (
        <Pressable onPress={() => router.push('/server')} hitSlop={8}>
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm, textDecorationLine: 'underline' }}>
            Check the server address
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

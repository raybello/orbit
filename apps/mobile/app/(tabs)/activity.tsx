import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { ActivityItem, Bot } from '@orbit/contracts';
import { BotAvatarFor } from '../../components/bot-avatar';
import { Chip, ScreenHeader, StateBlock, Tag } from '../../components/ui';
import { buildActivityFeed } from '../../lib/activity';
import { timeAgo } from '../../lib/format';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useBotsQuery } from '../../lib/queries';
import { useOrbitStore } from '../../lib/store';

/**
 * Everything your bots have said or done, across every bot, newest first.
 *
 * The server's `activity` frames have no producer yet, so the feed is built from what the app does
 * know — each bot's last message from GET /api/bots, plus the live turn state the SSE stream keeps
 * current — and streamed frames are folded in as soon as a server sends them
 * (see lib/activity.ts).
 */

type Filter = 'all' | 'message' | 'card' | 'working';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'message', label: 'Messages' },
  { value: 'card', label: 'Needs you' },
  { value: 'working', label: 'Working' },
];

/** The small right-hand label for anything that is not just a message. */
const TAG_LABEL: Partial<Record<ActivityItem['kind'], { label: string; tone: 'accent' | 'warn' | 'success' }>> = {
  card: { label: 'Needs you', tone: 'warn' },
  working: { label: 'Working', tone: 'accent' },
  completed: { label: 'Done', tone: 'success' },
};

export default function ActivityScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bots = useOrbitStore((s) => s.bots);
  const live = useOrbitStore((s) => s.live);
  const streamed = useOrbitStore((s) => s.activity);
  const [filter, setFilter] = useState<Filter>('all');

  const { isLoading, isError, error, refetch, isRefetching } = useBotsQuery();

  const items = useMemo(() => buildActivityFeed({ bots, live, streamed }), [bots, live, streamed]);
  const shown = useMemo(
    () => (filter === 'all' ? items : items.filter((item) => item.kind === filter)),
    [items, filter],
  );

  const open = useCallback((item: ActivityItem) => {
    router.push(`/thread/${item.botId}`);
  }, []);

  const head = (
    <>
      <ScreenHeader
        title="Activity"
        right={
          <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm }}>
            {items.length ? `${items.length}` : ''}
          </Text>
        }
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: tokens.space.sm, paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.md }}
      >
        {FILTERS.map((option) => (
          <Chip key={option.value} label={option.label} active={filter === option.value} onPress={() => setFilter(option.value)} />
        ))}
      </ScrollView>
    </>
  );

  if (isError && !bots.length) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
        {head}
        <StateBlock
          kind="error"
          message={error instanceof Error ? error.message : 'Could not load activity.'}
          onRetry={() => void refetch()}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      {head}
      <FlatList
        data={shown}
        keyExtractor={(item) => `${item.botId}-${item.kind}-${item.at}`}
        contentContainerStyle={{ paddingBottom: insets.bottom + tokens.space.xxl, flexGrow: 1 }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={tokens.colors.fgSecondary} />
        }
        ListEmptyComponent={
          isLoading && !bots.length ? (
            <StateBlock kind="loading" title="Loading activity…" />
          ) : (
            <StateBlock
              kind="empty"
              title={items.length === 0 ? 'Nothing yet' : 'Nothing matches this filter'}
              message={
                items.length === 0
                  ? 'Messages, questions and turns from your bots show up here as they happen.'
                  : 'Try another filter to see the rest of the feed.'
              }
            />
          )
        }
        ItemSeparatorComponent={() => (
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: tokens.colors.borderTertiary, marginLeft: 62 }} />
        )}
        renderItem={({ item }) => (
          <ActivityRow item={item} tokens={tokens} onPress={() => open(item)} bot={bots.find((b) => b.id === item.botId)} />
        )}
      />
    </View>
  );
}

function ActivityRow({
  item,
  tokens,
  onPress,
  bot,
}: {
  item: ActivityItem;
  tokens: MobileTokens;
  onPress: () => void;
  bot: Bot | undefined;
}) {
  const tag = TAG_LABEL[item.kind];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.botName}: ${item.preview}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: tokens.space.md,
        paddingHorizontal: tokens.space.xl,
        paddingVertical: tokens.space.md,
        backgroundColor: pressed ? tokens.colors.bgHover : 'transparent',
      })}
    >
      <BotAvatarFor bot={bot ?? { name: item.botName, avatarShape: 'blob', avatarColor: 'gray' }} size={34} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
          <Text numberOfLines={1} style={{ flex: 1, color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '500' }}>
            {item.botName}
          </Text>
          {tag ? <Tag label={tag.label} tone={tag.tone} /> : null}
          <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>{timeAgo(item.at)}</Text>
        </View>
        <Text numberOfLines={2} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 18 }}>
          {item.preview || 'No preview'}
        </Text>
      </View>
    </Pressable>
  );
}

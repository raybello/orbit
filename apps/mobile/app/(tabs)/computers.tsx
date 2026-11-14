import { useMemo } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ComputerCard } from '../../components/ComputerCard.native';
import { ScreenHeader, StateBlock } from '../../components/ui';
import { useMobileTokens } from '../../lib/native';
import { useComputersQuery } from '../../lib/queries';
import { useOrbitStore } from '../../lib/store';

/**
 * Every bot's computer in one list, with the way into its live screen.
 *
 * Bots without a computer are counted in a footer line rather than given an empty card, so the list
 * only ever holds something a person can look at. The screen opens the existing
 * app/computer/[botId] viewer — the same noVNC WebView the thread header and the roster push.
 */
export default function ComputersScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bots = useOrbitStore((s) => s.bots);
  const { data, isLoading, isError, error, refetch, isRefetching } = useComputersQuery();

  const withComputer = useMemo(() => (data ?? []).filter((c) => c.kind !== 'none'), [data]);
  const without = (data?.length ?? 0) - withComputer.length;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      <ScreenHeader
        title="Computers"
        subtitle={data ? `${withComputer.length} ${withComputer.length === 1 ? 'computer' : 'computers'}` : null}
        right={
          <Pressable onPress={() => void refetch()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Refresh computers">
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>
              {isRefetching ? 'Refreshing…' : 'Refresh'}
            </Text>
          </Pressable>
        }
      />

      {isError && !data ? (
        <StateBlock
          kind="error"
          message={error instanceof Error ? error.message : 'Could not read the computers.'}
          onRetry={() => void refetch()}
        />
      ) : (
        <FlatList
          data={withComputer}
          keyExtractor={(computer) => computer.botId}
          contentContainerStyle={{ padding: tokens.space.xl, paddingTop: tokens.space.sm, gap: tokens.space.md, flexGrow: 1, paddingBottom: insets.bottom + tokens.space.xxl }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={tokens.colors.fgSecondary} />
          }
          ListEmptyComponent={
            isLoading ? (
              <StateBlock kind="loading" title="Loading computers…" />
            ) : (
              <StateBlock
                kind="empty"
                title="No computers yet"
                message="A bot gets a computer when it is set up for one on the server. Once it has one, its screen shows up here."
              />
            )
          }
          ListFooterComponent={
            without > 0 ? (
              <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption, textAlign: 'center', paddingTop: tokens.space.md }}>
                {without} {without === 1 ? 'bot has' : 'bots have'} no computer
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <ComputerCard
              computer={item}
              bot={bots.find((b) => b.id === item.botId)}
              onOpen={(botId) => router.push(`/computer/${botId}`)}
            />
          )}
        />
      )}
    </View>
  );
}

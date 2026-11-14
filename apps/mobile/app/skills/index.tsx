import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { SkillEntry } from '@orbit/contracts';
import { Card, StateBlock, Tag } from '../../components/ui';
import { useMobileTokens } from '../../lib/native';
import { useSetSkillEnabled, useSkillsQuery } from '../../lib/queries';
import { useOrbitStore } from '../../lib/store';

/**
 * Skills: the primary agent's MCP servers, and one switch per bot.
 *
 * The primary agent reads its skills from its own Hermes config, so its row is locked on and the
 * server refuses a write for it — the switch is disabled rather than hidden, so the row still says
 * what the primary has. Every other switch is optimistic: it flips now, the config is written
 * behind it, and a refusal flips it back with a line saying what failed.
 */
export default function SkillsScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bots = useOrbitStore((s) => s.bots);
  const query = useSkillsQuery();
  const setEnabled = useSetSkillEnabled();
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const primaryId = useMemo(() => bots.find((b) => b.isPrimary)?.id ?? null, [bots]);

  const toggle = useCallback(
    async (skill: SkillEntry, botId: string, botName: string, enabled: boolean) => {
      const key = `${skill.name}:${botId}`;
      setError(null);
      setPendingKey(key);
      try {
        await setEnabled.mutateAsync({ botId, skillName: skill.name, enabled });
      } catch (e) {
        setError(`Couldn't update ${skill.name} for ${botName}. ${e instanceof Error ? e.message : 'Try again.'}`);
      } finally {
        setPendingKey(null);
      }
    },
    [setEnabled],
  );

  const skills = query.data;

  if (query.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
        <StateBlock
          kind="error"
          title="Couldn't load skills"
          message={query.error instanceof Error ? query.error.message : 'Try again in a moment.'}
          onRetry={() => void query.refetch()}
        />
      </View>
    );
  }

  if (query.isLoading && !skills) {
    return (
      <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
        <StateBlock kind="loading" title="Loading skills…" />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.colors.bg }}
      contentContainerStyle={{ padding: tokens.space.xl, gap: tokens.space.md, paddingBottom: insets.bottom + tokens.space.xxl }}
      refreshControl={
        <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} tintColor={tokens.colors.fgSecondary} />
      }
    >
      {error ? (
        <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.sm }} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {skills && skills.length === 0 ? (
        <View style={{ alignItems: 'center', gap: tokens.space.sm, paddingVertical: tokens.space.huge }}>
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '500' }}>No skills yet</Text>
          <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, textAlign: 'center', lineHeight: 19 }}>
            Skills come from the primary agent&apos;s Hermes config. Add an MCP server there and it shows up here.
          </Text>
        </View>
      ) : null}

      {(skills ?? []).map((skill) => {
        const enabledCount = skill.bots.filter((b) => b.enabled).length;
        // The server lists the primary agent first; before the roster loads, that row is it.
        const primaryBotId = primaryId ?? skill.bots[0]?.botId ?? null;
        return (
          <Card key={skill.name} style={{ padding: tokens.space.lg, gap: tokens.space.md }}>
            <View style={{ gap: tokens.space.xs }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.sm }}>
                <Text numberOfLines={1} style={{ flex: 1, color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>
                  {skill.name}
                </Text>
                <Tag label={skill.type === 'http' ? 'HTTP' : skill.type === 'stdio' ? 'stdio' : skill.type} />
              </View>
              {skill.description ? (
                <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 19 }}>
                  {skill.description}
                </Text>
              ) : null}
              {skill.url ? (
                <Text numberOfLines={1} style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption, fontFamily: tokens.mono }}>
                  {skill.url}
                </Text>
              ) : null}
              <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>
                {enabledCount} {enabledCount === 1 ? 'bot' : 'bots'}
              </Text>
            </View>

            <View style={{ gap: tokens.space.xs }}>
              {skill.bots.map((row) => {
                const locked = row.botId === primaryBotId;
                const key = `${skill.name}:${row.botId}`;
                return (
                  <View
                    key={row.botId}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: tokens.space.md,
                      paddingVertical: tokens.space.sm,
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: tokens.colors.border,
                    }}
                  >
                    <Text numberOfLines={1} style={{ flex: 1, color: tokens.colors.fg, fontSize: tokens.fontSizes.message }}>
                      {row.botName}
                    </Text>
                    {locked ? (
                      <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.caption }}>Read-only</Text>
                    ) : null}
                    <Switch
                      value={row.enabled}
                      disabled={locked || pendingKey === key}
                      onValueChange={(next) => void toggle(skill, row.botId, row.botName, next)}
                      trackColor={{ false: tokens.colors.bgSubtle, true: tokens.colors.accent }}
                      thumbColor={tokens.colors.bgElevated}
                      ios_backgroundColor={tokens.colors.bgSubtle}
                      accessibilityLabel={`${skill.name} for ${row.botName}`}
                    />
                  </View>
                );
              })}
            </View>
          </Card>
        );
      })}
    </ScrollView>
  );
}

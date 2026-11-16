import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { deepLinkTarget } from '@orbit/contracts';
import { useBotsQuery } from '../lib/queries';
import { useMobileTokens } from '../lib/native';
import { useOrbitStore } from '../lib/store';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Where an `orbit://app/v1/prompt` link lands (see +native-intent.tsx). Once the roster is known it
 * picks the Bot (the named one, else the primary) and replaces itself with that Bot's thread, the
 * link's text waiting in the composer. Nothing is sent.
 */
export default function PromptLinkScreen() {
  const params = useLocalSearchParams<{ id?: string; text?: string }>();
  const tokens = useMobileTokens();
  const bots = useOrbitStore((s) => s.bots);
  const roster = useBotsQuery();
  const id = first(params.id) || null;
  const text = first(params.text) ?? '';

  useEffect(() => {
    if (!bots.length && !roster.isFetched) return;
    const botId = deepLinkTarget(bots, { kind: 'prompt', botId: id, text });
    if (!botId) {
      router.replace('/(tabs)');
      return;
    }
    router.replace({ pathname: '/thread/[botId]', params: text ? { botId, initialText: text } : { botId } });
  }, [bots, roster.isFetched, id, text]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.bg }}>
      <ActivityIndicator color={tokens.colors.fgTertiary} />
    </View>
  );
}

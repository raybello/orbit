import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { pairLink, parsePairLink, type PairLink, type PairRedeemRequest, type SignInResponse } from '@orbit/contracts';
import { OrbitApiError, orbitPost } from '../lib/api';
import { saveApiBase } from '../lib/api-server';
import { registerPushNotifications } from '../lib/push';
import { saveSessionToken } from '../lib/session';
import { useOrbitStore } from '../lib/store';
import { useMobileTokens } from '../lib/native';

/**
 * Where `orbit://pair?server=…&code=…` lands: the QR in the computer's Settings → Devices. The code
 * is redeemed at that server for a session of the account that showed the QR, and only then does the
 * app switch servers, so a failed scan leaves whatever the app was signed in to untouched.
 */
export default function PairScreen() {
  const tokens = useMobileTokens();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ server?: string; code?: string }>();
  const link = parsePairLink(pairLink({ server: String(params.server ?? ''), code: String(params.code ?? '') }));
  const [error, setError] = useState<string | null>(link ? null : 'This is not an Orbit pairing code.');

  const pair = useCallback(
    async ({ server, code }: PairLink) => {
      setError(null);
      try {
        const session = await orbitPost<SignInResponse>(server, '/api/auth/pair/redeem', { code } satisfies PairRedeemRequest, {
          auth: false,
          timeoutMs: 15_000,
        });
        await saveApiBase(server);
        await saveSessionToken(session.token);
        queryClient.clear();
        useOrbitStore.getState().reset();
        void registerPushNotifications(server);
        router.replace('/(tabs)');
      } catch (e) {
        setError(
          e instanceof OrbitApiError && e.status
            ? e.message
            : `Could not reach ${server}. Check that your phone is on the same Wi-Fi as your computer and that “Allow my phone to connect” is on.`,
        );
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (link) void pair(link);
    // The link's two parts are what identify a scan; a re-render with the same link is not a new one.
  }, [link?.server, link?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg, padding: tokens.space.xxl, justifyContent: 'center', gap: tokens.space.lg }}>
      <Text style={{ color: tokens.colors.fg, fontSize: 28, fontWeight: '600', letterSpacing: -0.5 }}>
        {error ? 'Could not connect' : 'Connecting…'}
      </Text>
      {link ? (
        <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, fontFamily: tokens.mono }}>{link.server}</Text>
      ) : null}
      {error ? (
        <>
          <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.base, lineHeight: 22 }}>{error}</Text>
          {link ? (
            <Pressable
              onPress={() => void pair(link)}
              style={{ backgroundColor: tokens.colors.accent, borderRadius: tokens.radii.md, paddingVertical: tokens.space.lg, alignItems: 'center' }}
            >
              <Text style={{ color: tokens.colors.onAccent, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>Try again</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => router.replace('/sign-in')} hitSlop={8} style={{ alignItems: 'center' }}>
            <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm }}>Sign in another way</Text>
          </Pressable>
        </>
      ) : (
        <ActivityIndicator color={tokens.colors.fg} style={{ alignSelf: 'flex-start' }} />
      )}
    </View>
  );
}

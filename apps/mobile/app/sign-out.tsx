import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { currentApiBase } from '../lib/api-server';
import { unregisterPushNotifications } from '../lib/push';
import { clearSessionToken } from '../lib/session';
import { useOrbitStore } from '../lib/store';
import { useMobileTokens } from '../lib/native';

/** Signing out forgets the session, not the server: the next sign-in goes to the same address. */
export default function SignOutScreen() {
  const tokens = useMobileTokens();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      const apiBase = await currentApiBase();
      await unregisterPushNotifications(apiBase);
    } catch {
      /* the token is dropped locally either way */
    }
    await clearSessionToken();
    queryClient.clear();
    useOrbitStore.getState().reset();
    router.replace('/sign-in');
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg, padding: tokens.space.xl, gap: tokens.space.lg }}>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>
        Sign out of Orbit?
      </Text>
      <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.base, lineHeight: 20 }}>
        This phone forgets its session and stops receiving notifications. Your bots keep running on the server, and
        you can sign in again with the same owner key.
      </Text>

      <View style={{ flexDirection: 'row', gap: tokens.space.sm, marginTop: tokens.space.sm }}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
          disabled={busy}
          style={{
            flex: 1,
            alignItems: 'center',
            paddingVertical: tokens.space.lg,
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.bgElevated,
            borderWidth: 0.5,
            borderColor: tokens.colors.border,
          }}
        >
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message }}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={signOut}
          disabled={busy}
          style={{
            flex: 1,
            alignItems: 'center',
            paddingVertical: tokens.space.lg,
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.destructive,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={{ color: '#FFFFFF', fontSize: tokens.fontSizes.message, fontWeight: '600' }}>Sign out</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

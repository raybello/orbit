import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { SignInRequest, SignInResponse } from '@orbit/contracts';
import { OrbitApiError, orbitPost } from '../lib/api';
import { currentApiBase } from '../lib/api-server';
import { registerPushNotifications } from '../lib/push';
import { saveSessionToken } from '../lib/session';
import { useOrbitStore } from '../lib/store';
import { useMobileTokens } from '../lib/native';

/**
 * The server has no password store: a session comes from the owner key (the same secret
 * /api/auth/owner uses) or, on a dev server, an email on its own. Both arrive as a bearer token
 * that the app keeps in the keychain.
 */
export default function SignInScreen() {
  const tokens = useMobileTokens();
  const queryClient = useQueryClient();
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [ownerKey, setOwnerKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<TextInput>(null);

  useEffect(() => {
    currentApiBase().then(setApiBase).catch(() => setApiBase(null));
  }, []);

  const canSubmit = email.trim().length > 3 && !busy;

  async function signIn() {
    if (!apiBase || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const body: SignInRequest = { email: email.trim().toLowerCase() };
      if (ownerKey.trim()) body.ownerKey = ownerKey.trim();

      const response = await orbitPost<SignInResponse>(apiBase, '/api/auth/sign-in', body, {
        auth: false,
        timeoutMs: 15_000,
      });
      await saveSessionToken(response.token);
      queryClient.clear();
      useOrbitStore.getState().reset();
      void registerPushNotifications(apiBase);
      router.replace('/(tabs)');
    } catch (e) {
      setError(e instanceof OrbitApiError ? e.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: tokens.space.xxl, gap: tokens.space.lg }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: tokens.space.xs, marginTop: tokens.space.xxxl }}>
          <Text style={{ color: tokens.colors.fg, fontSize: 32, fontWeight: '600', letterSpacing: -0.5 }}>Orbit</Text>
          <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.base }}>
            Your team of agents, on your phone.
          </Text>
        </View>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: tokens.space.sm,
            paddingVertical: tokens.space.sm,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: tokens.colors.border,
          }}
        >
          <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.xs }}>SERVER</Text>
          <Text numberOfLines={1} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, flex: 1 }}>
            {apiBase ?? 'Looking up…'}
          </Text>
          <Pressable onPress={() => router.push('/server')} hitSlop={8}>
            <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>Change</Text>
          </Pressable>
        </View>

        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={tokens.colors.fgTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          returnKeyType="next"
          onSubmitEditing={() => keyRef.current?.focus()}
          style={fieldStyle(tokens)}
        />

        <TextInput
          ref={keyRef}
          value={ownerKey}
          onChangeText={setOwnerKey}
          placeholder="Owner key (or leave empty on a dev server)"
          placeholderTextColor={tokens.colors.fgTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={signIn}
          style={fieldStyle(tokens)}
        />

        {error ? (
          <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.sm }}>{error}</Text>
        ) : null}

        <Pressable
          onPress={signIn}
          disabled={!canSubmit}
          style={{
            backgroundColor: tokens.colors.accent,
            opacity: canSubmit ? 1 : 0.4,
            borderRadius: tokens.radii.composer,
            paddingVertical: tokens.space.lg,
            alignItems: 'center',
            marginTop: tokens.space.sm,
          }}
        >
          {busy ? (
            <ActivityIndicator color={tokens.colors.onAccent} />
          ) : (
            <Text style={{ color: tokens.colors.onAccent, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>Sign in</Text>
          )}
        </Pressable>

        <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.xs, lineHeight: 17 }}>
          The owner key is the one in your server&apos;s .env (SESSION_SECRET). With DEV_LOGIN=1 a dev server
          accepts your email alone.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function fieldStyle(tokens: ReturnType<typeof useMobileTokens>) {
  return {
    backgroundColor: tokens.colors.bgSubtle,
    color: tokens.colors.fg,
    borderRadius: tokens.radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: tokens.colors.border,
    paddingHorizontal: tokens.space.lg,
    paddingVertical: tokens.space.lg,
    fontSize: tokens.fontSizes.message,
  } as const;
}

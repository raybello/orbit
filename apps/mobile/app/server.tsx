import { useEffect, useState } from 'react';
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
import { router } from 'expo-router';
import { currentApiBase, resetApiBase, saveApiBase } from '../lib/api-server';
import { apiBaseWarning, defaultApiBase, normalizeApiBase, probeApiBase, type ProbeResult } from '../lib/endpoint';
import { useMobileTokens } from '../lib/native';

/**
 * The server screen: type an address, check it answers, save it. Orbit servers are self-hosted, so
 * there is nothing to discover — the person always knows the URL.
 */
export default function ServerScreen() {
  const tokens = useMobileTokens();
  const [value, setValue] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    currentApiBase().then(setValue).catch(() => setValue(defaultApiBase()));
  }, []);

  const normalized = normalizeApiBase(value);
  const warning = normalized.ok ? apiBaseWarning(normalized.url) : null;

  async function check() {
    if (!normalized.ok) {
      setError(normalized.error);
      setResult(null);
      return;
    }
    setChecking(true);
    setError(null);
    setResult(await probeApiBase(normalized.url));
    setChecking(false);
  }

  async function save() {
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    await saveApiBase(normalized.url);
    if (router.canGoBack()) router.back();
    else router.replace('/sign-in');
  }

  async function useDefault() {
    await resetApiBase();
    const fallback = defaultApiBase();
    setValue(fallback);
    setResult(null);
    setError(null);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens.colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: tokens.space.xl, gap: tokens.space.lg }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, lineHeight: 20 }}>
          The address of your Orbit server, including http:// or https://. A dev server on this machine is{' '}
          <Text style={{ fontFamily: tokens.mono }}>{defaultApiBase()}</Text>.
        </Text>

        <TextInput
          value={value}
          onChangeText={(next) => {
            setValue(next);
            setResult(null);
            setError(null);
          }}
          placeholder="https://orbit.example.com"
          placeholderTextColor={tokens.colors.fgTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          inputMode="url"
          style={{
            backgroundColor: tokens.colors.bgSubtle,
            color: tokens.colors.fg,
            borderRadius: tokens.radii.md,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: tokens.colors.border,
            paddingHorizontal: tokens.space.lg,
            paddingVertical: tokens.space.lg,
            fontFamily: tokens.mono,
            fontSize: tokens.fontSizes.base,
          }}
        />

        {error ? <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.sm }}>{error}</Text> : null}
        {warning ? <Text style={{ color: tokens.colors.warn, fontSize: tokens.fontSizes.sm }}>{warning}</Text> : null}

        <Pressable
          onPress={check}
          disabled={checking || !value.trim()}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: tokens.space.sm,
            backgroundColor: tokens.colors.bgElevated,
            borderColor: tokens.colors.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: tokens.radii.md,
            paddingVertical: tokens.space.lg,
            opacity: checking || !value.trim() ? 0.5 : 1,
          }}
        >
          {checking ? <ActivityIndicator color={tokens.colors.fg} /> : null}
          <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message }}>Check connection</Text>
        </Pressable>

        {result ? (
          <View
            style={{
              backgroundColor: result.ok ? tokens.colors.successBg : tokens.colors.destructiveBg,
              borderRadius: tokens.radii.md,
              padding: tokens.space.lg,
              gap: 2,
            }}
          >
            <Text style={{ color: result.ok ? tokens.colors.success : tokens.colors.destructive, fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>
              {result.ok ? 'Connected' : 'Not reachable'}
            </Text>
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>
              {result.ok
                ? [result.engine ? `engine ${result.engine}` : null, result.version ? `v${result.version}` : null]
                    .filter(Boolean)
                    .join(' · ') || 'An Orbit server answered.'
                : result.error ?? 'No answer.'}
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={save}
          disabled={!normalized.ok}
          style={{
            backgroundColor: tokens.colors.accent,
            opacity: normalized.ok ? 1 : 0.4,
            borderRadius: tokens.radii.md,
            paddingVertical: tokens.space.lg,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: tokens.colors.onAccent, fontSize: tokens.fontSizes.lg, fontWeight: '600' }}>Save</Text>
        </Pressable>

        <Pressable onPress={useDefault} hitSlop={8} style={{ alignItems: 'center' }}>
          <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm }}>Use the default address</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { currentApiBase } from '../../lib/api-server';
import { apiBaseWarning, probeApiBase, type ProbeResult } from '../../lib/endpoint';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { registerPushNotifications } from '../../lib/push';

/** Server, notifications, and the way out. Nothing here writes to the server except the push token. */
export default function SettingsScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [health, setHealth] = useState<ProbeResult | null>(null);
  const [pushState, setPushState] = useState<string>('…');

  useEffect(() => {
    (async () => {
      const base = await currentApiBase();
      setApiBase(base);
      setHealth(await probeApiBase(base));
      const permission = await Notifications.getPermissionsAsync();
      setPushState(permission.granted ? 'Allowed' : permission.canAskAgain ? 'Not enabled' : 'Blocked in Settings');
    })().catch(() => undefined);
  }, []);

  const warning = apiBase ? apiBaseWarning(apiBase) : null;

  async function enablePush() {
    if (!apiBase) return;
    setPushState('Asking…');
    const result = await registerPushNotifications(apiBase);
    setPushState(
      result === 'registered'
        ? 'Allowed'
        : result === 'denied'
          ? 'Blocked in Settings'
          : result === 'no-project-id'
            ? 'Needs an EAS project id'
            : 'Not available',
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      <View style={{ paddingTop: insets.top + tokens.space.sm, paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.sm }}>
        <Text style={{ color: tokens.colors.fg, fontSize: 30, fontWeight: '600', letterSpacing: -0.5 }}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: tokens.space.xl, paddingTop: tokens.space.sm, gap: tokens.space.xl, paddingBottom: insets.bottom + tokens.space.xxl }}>
        <Section title="Server" tokens={tokens}>
          <Row tokens={tokens} label="Address" value={apiBase ?? '…'} mono />
          <Row
            tokens={tokens}
            label="Connection"
            value={health ? (health.ok ? `Connected${health.version ? ` · v${health.version}` : ''}` : health.error ?? 'Not reachable') : 'Checking…'}
            tone={health ? (health.ok ? 'success' : 'error') : 'muted'}
          />
          {warning ? (
            <Text style={{ color: tokens.colors.warn, fontSize: tokens.fontSizes.xs, paddingHorizontal: tokens.space.lg, paddingBottom: tokens.space.sm }}>
              {warning}
            </Text>
          ) : null}
          <Action tokens={tokens} label="Change server" onPress={() => router.push('/server')} />
        </Section>

        <Section title="Notifications" tokens={tokens}>
          <Row tokens={tokens} label="Push" value={pushState} />
          <Action tokens={tokens} label="Enable notifications" onPress={() => void enablePush()} />
        </Section>

        <Section title="About" tokens={tokens}>
          <Row tokens={tokens} label="Version" value={Constants.expoConfig?.version ?? '0.1.0'} />
          <Row tokens={tokens} label="Runtime" value={Constants.expoConfig?.sdkVersion ? `Expo SDK ${Constants.expoConfig.sdkVersion}` : 'Expo'} />
        </Section>

        <Pressable
          onPress={() => router.push('/sign-out')}
          style={{
            backgroundColor: tokens.colors.destructiveBg,
            borderRadius: tokens.radii.card,
            paddingVertical: tokens.space.lg,
            alignItems: 'center',
          }}
        >
          <Text style={{ color: tokens.colors.destructive, fontSize: tokens.fontSizes.message, fontWeight: '600' }}>Sign out</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Section({ title, tokens, children }: { title: string; tokens: MobileTokens; children: React.ReactNode }) {
  return (
    <View style={{ gap: tokens.space.sm }}>
      <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.xs, textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: tokens.space.xs }}>
        {title}
      </Text>
      <View
        style={{
          backgroundColor: tokens.colors.bgElevated,
          borderRadius: tokens.radii.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: tokens.colors.border,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

function Row({
  tokens,
  label,
  value,
  mono,
  tone = 'muted',
}: {
  tokens: MobileTokens;
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'muted' | 'success' | 'error';
}) {
  const color = tone === 'success' ? tokens.colors.success : tone === 'error' ? tokens.colors.destructive : tokens.colors.fgSecondary;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: tokens.space.md, paddingHorizontal: tokens.space.lg, paddingVertical: tokens.space.md }}>
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message }}>{label}</Text>
      <Text
        numberOfLines={2}
        style={{ color, fontSize: tokens.fontSizes.sm, flex: 1, textAlign: 'right', fontFamily: mono ? tokens.mono : undefined }}
      >
        {value}
      </Text>
    </View>
  );
}

function Action({ tokens, label, onPress }: { tokens: MobileTokens; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: tokens.space.lg,
        paddingVertical: tokens.space.md,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: tokens.colors.border,
        backgroundColor: pressed ? tokens.colors.bgHover : 'transparent',
      })}
    >
      <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message }}>{label}</Text>
    </Pressable>
  );
}

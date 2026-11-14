import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { WebView } from 'react-native-webview';
import { currentApiBase } from '../../lib/api-server';
import { getSessionToken } from '../../lib/session';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useOrbitStore } from '../../lib/store';
import { vncWebSocketUrl, type ScreenMode } from '../../lib/vnc-url';

/** The bundled viewer: one HTML file with noVNC inlined (see scripts/build-vnc-viewer.mjs). */
const VIEWER_PAGE = require('../../assets/vnc-viewer/index.html');

/**
 * A bot's screen, live: the bundled noVNC page (the same library the web app uses) inside a WebView,
 * pointed at the server's VNC relay with the session token. Watching is view-only — the relay drops
 * input events in watch mode too, so a stray tap on a watched screen cannot move the bot's mouse.
 */
export default function ComputerScreen() {
  const params = useLocalSearchParams<{ botId: string }>();
  const botId = Array.isArray(params.botId) ? params.botId[0] : (params.botId ?? '');
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const bot = useOrbitStore((s) => s.bots.find((b) => b.id === botId));

  const [mode, setMode] = useState<ScreenMode>('watch');
  const [attempt, setAttempt] = useState(0);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'lost'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [apiBase, token] = await Promise.all([currentApiBase(), getSessionToken()]);
      if (!alive) return;
      if (!token) {
        setError('Sign in again to see this screen.');
        return;
      }
      setWsUrl(vncWebSocketUrl(apiBase, botId, token, mode));
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : 'Could not open the screen.');
    });
    return () => {
      alive = false;
    };
  }, [botId, mode]);

  const reload = useCallback(() => {
    setStatus('connecting');
    setAttempt((n) => n + 1);
  }, []);

  const takeControl = useCallback(() => {
    Alert.alert(
      'Take control?',
      `${bot?.name ?? 'This bot'} keeps working, but your taps and typing land on its screen until you hand back.`,
      [
        { text: 'Keep watching', style: 'cancel' },
        { text: 'Take control', onPress: () => setMode('control') },
      ],
    );
  }, [bot?.name]);

  const injected = useMemo(
    () => `window.__ORBIT_VNC__ = ${JSON.stringify({ wsUrl, mode })}; true;`,
    [wsUrl, mode],
  );

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: tokens.space.xxl, gap: tokens.space.md }}>
        <Text style={{ color: '#FFFFFF', fontSize: tokens.fontSizes.lg, textAlign: 'center' }}>No screen</Text>
        <Text style={{ color: '#9A9A9A', fontSize: tokens.fontSizes.sm, textAlign: 'center' }}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {wsUrl ? (
        <WebView
          // A new mode means a new RFB session: viewOnly is set at connect time in the page.
          key={`${mode}-${attempt}`}
          source={VIEWER_PAGE}
          injectedJavaScriptBeforeContentLoaded={injected}
          originWhitelist={['*']}
          javaScriptEnabled
          allowFileAccess
          allowUniversalAccessFromFileURLs
          mixedContentMode="always"
          setSupportMultipleWindows={false}
          scrollEnabled={false}
          bounces={false}
          style={{ flex: 1, backgroundColor: '#000' }}
          onMessage={(event) => {
            try {
              const message = JSON.parse(event.nativeEvent.data) as { type?: string; status?: string };
              if (message.type !== 'status') return;
              if (message.status === 'connected') setStatus('connected');
              else if (message.status === 'disconnected') setStatus('lost');
              else if (message.status === 'error') setStatus('lost');
            } catch {
              /* the page only ever posts JSON status frames */
            }
          }}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: tokens.space.md }}>
          <ActivityIndicator color="#FFFFFF" />
          <Text style={{ color: '#9A9A9A', fontSize: tokens.fontSizes.sm }}>Connecting to {bot?.name ?? 'the bot'}…</Text>
        </View>
      )}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: tokens.space.sm,
          paddingHorizontal: tokens.space.lg,
          paddingTop: tokens.space.md,
          paddingBottom: Math.max(insets.bottom, tokens.space.md),
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: '#FFFFFF1A',
          backgroundColor: '#0C0C0C',
        }}
      >
        <StatusDot status={status} tokens={tokens} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#F5F5F5', fontSize: tokens.fontSizes.sm }}>
            {mode === 'control' ? 'You have control' : status === 'connected' ? 'Live' : status === 'lost' ? 'Screen lost' : 'Connecting…'}
          </Text>
          <Text numberOfLines={1} style={{ color: '#8A8A8A', fontSize: 11 }}>
            {bot?.name ?? 'Bot'}’s computer
          </Text>
        </View>

        <Pressable onPress={reload} hitSlop={8} style={{ padding: tokens.space.sm }}>
          <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
            <Path
              d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"
              stroke="#F5F5F5"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </Pressable>

        <Pressable
          onPress={() => (mode === 'control' ? setMode('watch') : takeControl())}
          style={{
            paddingHorizontal: tokens.space.lg,
            paddingVertical: tokens.space.sm,
            borderRadius: tokens.radii.full,
            backgroundColor: mode === 'control' ? '#F5F5F5' : '#FFFFFF1A',
          }}
        >
          <Text style={{ color: mode === 'control' ? '#121212' : '#F5F5F5', fontSize: tokens.fontSizes.sm, fontWeight: '600' }}>
            {mode === 'control' ? 'Hand back' : 'Take control'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function StatusDot({ status, tokens }: { status: 'connecting' | 'connected' | 'lost'; tokens: MobileTokens }) {
  const color = status === 'connected' ? '#14C16F' : status === 'lost' ? '#FB2B3E' : '#8A8A8A';
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, marginRight: tokens.space.xxs }} />;
}

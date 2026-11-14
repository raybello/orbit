import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { FileEntry } from '@orbit/contracts';
import { currentFileUrl } from '../lib/files';
import { getSessionToken } from '../lib/session';
import { useMobileTokens } from '../lib/native';

/**
 * A file shown inside the app: a PDF or a text file in a WebView, with the session header attached
 * to the request.
 *
 * The download route sits behind the session, so a plain browser tab cannot open it and expo-sharing
 * has no local copy to hand over. The WebView is the one surface that can carry an Authorization
 * header, which makes it the honest way to look at the file rather than download it.
 */
export function FileViewer({ entry, onClose, onShare }: { entry: FileEntry; onClose: () => void; onShare: () => void }) {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [uri, token] = await Promise.all([currentFileUrl(entry), getSessionToken()]);
      if (alive) setSource({ uri, headers: token ? { authorization: `Bearer ${token}` } : {} });
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : 'Could not open that file.');
    });
    return () => {
      alive = false;
    };
  }, [entry]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen">
      <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: tokens.space.md,
            paddingTop: insets.top + tokens.space.sm,
            paddingBottom: tokens.space.sm,
            paddingHorizontal: tokens.space.lg,
            borderBottomWidth: 1,
            borderBottomColor: tokens.colors.border,
          }}
        >
          <Text numberOfLines={1} style={{ flex: 1, color: tokens.colors.fg, fontSize: tokens.fontSizes.sm }}>
            {entry.filename}
          </Text>
          <Pressable onPress={onShare} hitSlop={10} accessibilityRole="button" accessibilityLabel="Share">
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>Share</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg }}>✕</Text>
          </Pressable>
        </View>

        {error ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: tokens.space.xxl, gap: tokens.space.sm }}>
            <Text style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.lg }}>Could not open this file</Text>
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm, textAlign: 'center' }}>{error}</Text>
          </View>
        ) : source ? (
          <WebView
            source={source}
            originWhitelist={['*']}
            style={{ flex: 1, backgroundColor: tokens.colors.bg }}
            startInLoadingState
            renderLoading={() => (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: tokens.colors.bg }}>
                <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>Loading {entry.filename}…</Text>
              </View>
            )}
            onError={() => setError(`${entry.filename} is not something this view can show.`)}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.sm }}>Opening…</Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

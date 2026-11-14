import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FileEntry } from '@orbit/contracts';
import { FileRow } from '../../components/FileRow';
import { FileViewer } from '../../components/FileViewer';
import { Chip, ScreenHeader, StateBlock } from '../../components/ui';
import { fileKind, canPreview, currentFileUrl, openDownloadInBrowser, shareFile } from '../../lib/files';
import { getSessionToken } from '../../lib/session';
import { useMobileTokens, type MobileTokens } from '../../lib/native';
import { useFilesQuery } from '../../lib/queries';

/**
 * Every file the bots have: their Library, the attachments they sent, and their workspace.
 *
 * The list is a flat view over all three sources and every bot, filtered here by kind and search
 * text, and paged 50 at a time as the list scrolls. An image opens full screen (the download route
 * needs the session token, so a plain browser tab would not do); anything else goes to the OS share
 * sheet.
 */

type FileType = 'all' | 'library' | 'attachment' | 'workspace';

const FILTERS: { value: FileType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'library', label: 'Library' },
  { value: 'attachment', label: 'Attachments' },
  { value: 'workspace', label: 'Workspace' },
];

export default function FilesScreen() {
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();

  const [type, setType] = useState<FileType>('all');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  const [previewing, setPreviewing] = useState<FileEntry | null>(null);

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = useFilesQuery(type, term);
  const files = useMemo(() => query.data?.pages.flatMap((page) => page.files) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  const share = useCallback(
    async (entry: FileEntry) => {
      const result = await shareFile(entry);
      if (result === 'shared') return;
      // The share sheet could not take it. Show the file here when the app can, and only then
      // hand the URL to the browser — the download route needs the session, so a browser tab is
      // the least likely of the three to work.
      if (canPreview(entry)) {
        setPreviewing(entry);
        return;
      }
      if (await openDownloadInBrowser(entry)) return;
      Alert.alert('Could not open that file', `${entry.filename} could not be handed to another app.`);
    },
    [],
  );

  const open = useCallback(
    (entry: FileEntry) => {
      if (fileKind(entry) === 'image') setViewing(entry);
      else void share(entry);
    },
    [share],
  );

  const onEndReached = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  const firstLoad = query.isLoading && files.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.colors.bg }}>
      <ScreenHeader
        title="Files"
        right={
          <Text style={{ color: tokens.colors.fgTertiary, fontSize: tokens.fontSizes.sm }}>
            {total ? `${total}` : ''}
          </Text>
        }
      />

      <View style={{ paddingHorizontal: tokens.space.xl, paddingBottom: tokens.space.md, gap: tokens.space.md }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search files"
          placeholderTextColor={tokens.colors.fgTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={{
            backgroundColor: tokens.colors.bgSubtle,
            color: tokens.colors.fg,
            borderRadius: tokens.radii.md,
            paddingHorizontal: tokens.space.md,
            paddingVertical: tokens.space.sm,
            fontSize: tokens.fontSizes.message,
          }}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: tokens.space.sm }}>
          {FILTERS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              active={type === option.value}
              onPress={() => setType(option.value)}
            />
          ))}
        </View>
      </View>

      {query.isError && files.length === 0 ? (
        <StateBlock
          kind="error"
          message={query.error instanceof Error ? query.error.message : 'Could not load your files.'}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(entry) => entry.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + tokens.space.xxl, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching && !query.isFetchingNextPage}
              onRefresh={() => void query.refetch()}
              tintColor={tokens.colors.fgSecondary}
            />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            firstLoad ? (
              <StateBlock kind="loading" title="Loading files…" />
            ) : (
              <StateBlock
                kind="empty"
                title={term ? 'No files match' : 'No files yet'}
                message={
                  term
                    ? `Nothing here matches “${term}”. Try a shorter search or another filter.`
                    : 'Files a bot saves to its Library, sends in a chat, or writes in its workspace show up here.'
                }
              />
            )
          }
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <View style={{ paddingVertical: tokens.space.lg, alignItems: 'center' }}>
                <ActivityIndicator color={tokens.colors.fgSecondary} />
              </View>
            ) : null
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: tokens.colors.borderTertiary, marginLeft: 66 }} />
          )}
          renderItem={({ item }) => <FileRow entry={item} onPress={open} onLongPress={share} />}
        />
      )}

      {viewing ? <ImageModal entry={viewing} tokens={tokens} onClose={() => setViewing(null)} onShare={() => void share(viewing)} /> : null}
      {previewing ? (
        <FileViewer entry={previewing} onClose={() => setPreviewing(null)} onShare={() => void share(previewing)} />
      ) : null}
    </View>
  );
}

/**
 * A file at full size. `Image` sends the bearer token itself, which is the only way to read a
 * download that sits behind the session.
 */
function ImageModal({
  entry,
  tokens,
  onClose,
  onShare,
}: {
  entry: FileEntry;
  tokens: MobileTokens;
  onClose: () => void;
  onShare: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [uri, token] = await Promise.all([currentFileUrl(entry), getSessionToken()]);
      if (!alive) return;
      setSource({ uri, headers: token ? { authorization: `Bearer ${token}` } : {} });
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [entry]);

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} presentationStyle="overFullScreen">
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: tokens.space.md,
            paddingTop: insets.top + tokens.space.sm,
            paddingBottom: tokens.space.sm,
            paddingHorizontal: tokens.space.lg,
          }}
        >
          <Text numberOfLines={1} style={{ flex: 1, color: '#F5F5F5', fontSize: tokens.fontSizes.sm }}>
            {entry.filename}
          </Text>
          <Pressable onPress={onShare} hitSlop={10} accessibilityLabel="Share">
            <Text style={{ color: '#F5F5F5', fontSize: tokens.fontSizes.sm }}>Share</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
            <Text style={{ color: '#F5F5F5', fontSize: tokens.fontSizes.lg }}>✕</Text>
          </Pressable>
        </View>

        <Pressable style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} onPress={onClose}>
          {source ? (
            <Image
              source={source}
              resizeMode="contain"
              style={{ width: '100%', height: '100%' }}
              accessibilityLabel={entry.filename}
              accessible
              progressiveRenderingEnabled
            />
          ) : (
            <ActivityIndicator color="#FFFFFF" />
          )}
        </Pressable>

        <Text
          style={{
            color: '#8A8A8A',
            fontSize: tokens.fontSizes.caption,
            textAlign: 'center',
            paddingBottom: Math.max(insets.bottom, tokens.space.md),
          }}
          numberOfLines={1}
        >
          {entry.botName} · {entry.mediaType}
        </Text>
      </View>
    </Modal>
  );
}

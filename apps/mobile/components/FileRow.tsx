import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { FileEntry } from '@orbit/contracts';
import { fileKind, type FileKind } from '../lib/files';
import { formatBytes, shortDate } from '../lib/format';
import { useMobileTokens, type MobileTokens } from '../lib/native';

/**
 * One file in the Files tab: what it is called, which bot it belongs to, how big it is, and when it
 * arrived. The icon says the kind; tapping is the screen's business (an image opens full screen,
 * anything else goes to the share sheet).
 */

const ICONS: Record<FileKind, string> = {
  image: 'M4 5.5h16v13H4zM4 15l4.5-4.5L13 15l2.5-2.5L20 17M15.5 9.5h.01',
  audio: 'M12 4a2.5 2.5 0 0 0-2.5 2.5v5a2.5 2.5 0 0 0 5 0v-5A2.5 2.5 0 0 0 12 4ZM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20',
  video: 'M4 6.5h11v11H4zM15 10l5-3v10l-5-3',
  pdf: 'M7 3.5h7l4 4v13H7zM14 3.5V8h4M9.5 12.5h5M9.5 16h5',
  text: 'M7 3.5h7l4 4v13H7zM14 3.5V8h4M9.5 11.5h5M9.5 15h3',
  other: 'M14 3.5H7v17h10v-13zM14 3.5V8h3',
};

const KIND_LABEL: Record<FileKind, string> = {
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  pdf: 'PDF',
  text: 'Text',
  other: 'File',
};

export type FileRowProps = {
  entry: FileEntry;
  onPress: (entry: FileEntry) => void;
  onLongPress?: (entry: FileEntry) => void;
  /** Shown only when the list spans bots (the All filter); a bot-filtered list can leave it off. */
  showBot?: boolean;
};

function FileRowBase({ entry, onPress, onLongPress, showBot = true }: FileRowProps) {
  const tokens = useMobileTokens();
  const kind = fileKind(entry);

  return (
    <Pressable
      onPress={() => onPress(entry)}
      onLongPress={onLongPress ? () => onLongPress(entry) : undefined}
      accessibilityRole="button"
      accessibilityLabel={`${entry.filename}, ${KIND_LABEL[kind]}, ${formatBytes(entry.size)}, ${entry.botName}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: tokens.space.md,
        paddingHorizontal: tokens.space.xl,
        paddingVertical: tokens.space.md,
        backgroundColor: pressed ? tokens.colors.bgHover : 'transparent',
      })}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: tokens.radii.sm,
          backgroundColor: tokens.colors.bgSubtle,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
          <Path
            d={ICONS[kind]}
            stroke={tokens.colors.fgSecondary}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: tokens.colors.fg, fontSize: tokens.fontSizes.message, fontWeight: '500' }}>
          {entry.filename}
        </Text>
        <Text numberOfLines={1} style={{ color: tokens.colors.fgSecondary, fontSize: tokens.fontSizes.caption }}>
          {showBot ? `${entry.botName} · ` : ''}
          {formatBytes(entry.size)} · {shortDate(entry.createdAt)}
        </Text>
      </View>

      <Text style={{ color: tokens.colors.fgTertiary, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {KIND_LABEL[kind]}
      </Text>
    </Pressable>
  );
}

function FileSeparator({ tokens }: { tokens: MobileTokens }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: tokens.colors.borderTertiary, marginLeft: 66 }} />;
}

/** Rows are re-rendered only when their entry changes: a scrolling file list is 50 of these. */
export const FileRow = memo(FileRowBase);
export { FileSeparator };

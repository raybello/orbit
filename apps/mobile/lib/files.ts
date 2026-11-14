import type { FileEntry } from '@orbit/contracts';
import * as Sharing from 'expo-sharing';
import { Linking } from 'react-native';
import { currentApiBase } from './api-server';

/**
 * Files on a phone.
 *
 * The list endpoint hands back a `downloadUrl` path, not an absolute URL, because the server cannot
 * know which address the client reached it on. Downloads sit behind the session, so this module is
 * where a row becomes something the OS can do with it.
 */

export type FileKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'other';

/** Extensions worth treating as text even when the server says application/octet-stream. */
const TEXT_EXT = /\.(?:txt|md|markdown|mdx|log|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|jsx?|mjs|cjs|tsx?|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|sh|bash|zsh|fish|sql|graphql|gql|tex|lua|r|dart|vue|svelte)$/i;

/** What a file is, from its media type — the same buckets the web Files view uses. */
export function fileKind(entry: Pick<FileEntry, 'mediaType' | 'filename'>): FileKind {
  const media = (entry.mediaType || '').toLowerCase();
  if (media.startsWith('image/')) return 'image';
  if (media.startsWith('audio/')) return 'audio';
  if (media.startsWith('video/')) return 'video';
  if (media === 'application/pdf') return 'pdf';
  if (
    media.startsWith('text/') ||
    /(?:json|javascript|typescript|xml|yaml|x-sh|x-python|sql)/.test(media) ||
    TEXT_EXT.test(entry.filename)
  ) {
    return 'text';
  }
  return 'other';
}

/** The absolute, authenticated-in-header download URL for an entry. */
export function fileUrl(apiBase: string, entry: Pick<FileEntry, 'downloadUrl'>): string {
  const path = entry.downloadUrl.startsWith('/') ? entry.downloadUrl : `/${entry.downloadUrl}`;
  return `${apiBase.replace(/\/+$/, '')}${path}`;
}

export async function currentFileUrl(entry: Pick<FileEntry, 'downloadUrl'>): Promise<string> {
  return fileUrl(await currentApiBase(), entry);
}

export type ShareResult = 'shared' | 'unavailable' | 'failed';

/**
 * Hand a file to the OS share sheet.
 *
 * expo-sharing wants a local file, and the app has no filesystem module to stage one in, so the
 * authenticated download URL is what gets offered: on iOS that shares a link, and on Android the
 * call throws. 'unavailable' means the screen should show the file (or its URL) another way.
 */
export async function shareFile(entry: FileEntry): Promise<ShareResult> {
  const url = await currentFileUrl(entry);
  try {
    if (!(await Sharing.isAvailableAsync())) return 'unavailable';
    await Sharing.shareAsync(url, { mimeType: entry.mediaType, dialogTitle: entry.filename });
    return 'shared';
  } catch {
    return 'failed';
  }
}

/**
 * The last resort: open the download URL in the OS browser. The route needs the session, so this
 * only makes sense for a person who is already signed in there — which is why the screens call it
 * only after every in-app path has been offered.
 */
export async function openDownloadInBrowser(entry: FileEntry): Promise<boolean> {
  try {
    await Linking.openURL(await currentFileUrl(entry));
    return true;
  } catch {
    return false;
  }
}

/** True for the kinds the app can render itself, given the session header. */
export function canPreview(entry: Pick<FileEntry, 'mediaType' | 'filename'>): boolean {
  const kind = fileKind(entry);
  return kind === 'image' || kind === 'pdf' || kind === 'text';
}

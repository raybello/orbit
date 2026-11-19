import type { FileEntry } from '@orbit/contracts';

export type FileKind = 'image' | 'audio' | 'video' | 'pdf' | 'code' | 'other';

/** Extensions worth showing as text even when the server reports application/octet-stream. */
export const TEXT_EXT = /\.(?:txt|md|markdown|mdx|log|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|jsx?|mjs|cjs|tsx?|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|sh|bash|zsh|fish|sql|graphql|gql|tex|lua|r|dart|vue|svelte)$/i;

export function kindOf(entry: FileEntry): FileKind {
  const media = (entry.mediaType || '').toLowerCase();
  if (media.startsWith('image/')) return 'image';
  if (media.startsWith('audio/')) return 'audio';
  if (media.startsWith('video/')) return 'video';
  if (media === 'application/pdf') return 'pdf';
  if (media.startsWith('text/') || /(?:json|javascript|typescript|xml|yaml|x-sh|x-python|sql)/.test(media) || TEXT_EXT.test(entry.filename)) return 'code';
  return 'other';
}

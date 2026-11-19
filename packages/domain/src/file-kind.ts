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

/**
 * Which viewer opens a file: rendered Markdown, the image viewer, or the code viewer (syntax
 * highlighting by extension). `other` downloads: media and archives a text view cannot show. A
 * name with no known extension (Dockerfile, LICENSE, a log) opens as text; the viewer still checks
 * the bytes and offers the download when they turn out to be binary.
 */
export type ViewerKind = 'markdown' | 'image' | 'text' | 'other';

const MARKDOWN_EXT = /\.(?:md|markdown|mdx|mdown|mkd)$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const BINARY_EXT = /\.(?:mp3|m4a|ogg|wav|flac|aac|mp4|webm|mov|mkv|avi|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|exe|dll|so|dylib|bin|dmg|iso|img|o|a|class|pyc|wasm|db|sqlite3?|woff2?|ttf|otf|eot|psd|heic|onnx|gguf|safetensors|pt|pth|npy|parquet)$/i;

export function viewerFor(name: string, mediaType = ''): ViewerKind {
  const media = mediaType.toLowerCase();
  if (MARKDOWN_EXT.test(name) || media.startsWith('text/markdown')) return 'markdown';
  if (IMAGE_EXT.test(name) || media.startsWith('image/')) return 'image';
  if (BINARY_EXT.test(name) || /^(audio|video)\//.test(media) || media === 'application/pdf') return 'other';
  return 'text';
}

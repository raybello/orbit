/** File extension → media type, for Library files and chat attachments. */
export const MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
};

export function mediaTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * How a file is served: images, audio, video and PDFs open in the browser, the rest download.
 * A file a bot wrote is never trusted as a page of this app: the sandbox policy stops an SVG or
 * HTML opened directly from running script with the person's session.
 */
export function fileHeaders(name: string, size: number): Record<string, string> {
  const mediaType = mediaTypeFor(name);
  const inline = mediaType.startsWith('image/') || mediaType.startsWith('audio/') || mediaType.startsWith('video/') || mediaType === 'application/pdf';
  return {
    'content-type': mediaType,
    'content-length': String(size),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
  };
}

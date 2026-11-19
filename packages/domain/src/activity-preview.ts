/** A preview is one line in the feed; the cut (and its ellipsis) is pinned at this width by tests. */
export const PREVIEW_CHARS = 110;

export function activityPreview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

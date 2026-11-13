/** Small formatters the chat surfaces share. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "5m", "3h", "2d", or a date once it is older than a week. */
export function timeAgo(at: number, now = Date.now()): string {
  const delta = Math.max(0, now - at);
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Worked for 12s" / "Worked for 2m 5s" — the tool-run chip's headline. */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** One line of a message, for the chat list preview. */
export function previewText(text: string, max = 120): string {
  const flat = text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function unreadLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

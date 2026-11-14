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

/** "1.2 MB" — the same rounding the web app's file list uses. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  const digits = power === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[power]}`;
}

/** "Nov 4" this year, "Nov 4, 2025" otherwise — a file's date column. */
export function shortDate(at: number, now = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** Local calendar day key, e.g. 2026-11-04 — the key react-native-calendars marks days with. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** A day as the calendar grid understands it, parsed in local time (not UTC like `new Date(key)`). */
export function dayFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}


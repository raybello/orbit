import type { DocEdits, DocReview, EmailEdits, EmailReview, EventEdits, EventFields, EventReview, SheetEdits, SheetReview } from '@orbit/contracts';

// ─── email ─────────────────────────────────────────────────────────────────────

export const splitAddresses = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
export const joinAddresses = (a: string[]) => a.join(', ');

export interface EmailFields { to: string; cc: string; bcc: string; subject: string; body: string }

export const emailFieldsOf = (e: EmailReview): EmailFields => ({
  to: joinAddresses(e.to), cc: joinAddresses(e.cc), bcc: joinAddresses(e.bcc), subject: e.subject, body: e.body,
});

/** Only what the person changed, in the shape the server checks. */
export function emailEditsOf(e: EmailReview, f: EmailFields): EmailEdits | undefined {
  const out: EmailEdits = {};
  if (joinAddresses(splitAddresses(f.to)) !== joinAddresses(e.to)) out.to = splitAddresses(f.to);
  if (joinAddresses(splitAddresses(f.cc)) !== joinAddresses(e.cc)) out.cc = splitAddresses(f.cc);
  if (joinAddresses(splitAddresses(f.bcc)) !== joinAddresses(e.bcc)) out.bcc = splitAddresses(f.bcc);
  if (f.subject !== e.subject && e.action !== 'reply') out.subject = f.subject;
  if (f.body !== e.body) out.body = f.body;
  return Object.keys(out).length ? out : undefined;
}

// ─── event ─────────────────────────────────────────────────────────────────────

export const SCOPES: { value: 'this' | 'following' | 'all'; label: string }[] = [
  { value: 'this', label: 'This event' },
  { value: 'following', label: 'This and following' },
  { value: 'all', label: 'All events' },
];

/** "2026-11-19T15:00" read as wall-clock time (no timezone conversion: it already is the event's). */
export const asDate = (local: string) => new Date(`${local.length === 10 ? `${local}T00:00` : local}:00Z`);

const day = (local: string) => asDate(local).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const time = (local: string) => asDate(local).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/** "Thu, Nov 19 · 3:00 PM – 3:30 PM", "Thu, Dec 24 – Fri, Dec 25 · All day". */
export function whenOf(f: Pick<EventFields, 'start' | 'end' | 'allDay'>): string {
  if (!f.start) return 'No time set';
  if (f.allDay) return `${day(f.start)}${f.end && f.end.slice(0, 10) !== f.start.slice(0, 10) ? ` – ${day(f.end)}` : ''} · All day`;
  const sameDay = f.end.slice(0, 10) === f.start.slice(0, 10);
  return `${day(f.start)} · ${time(f.start)} – ${sameDay ? '' : `${day(f.end)} `}${time(f.end)}`;
}

/** Only what the person changed, in the shape the server checks. */
export function eventEditsOf(review: EventReview, f: EventFields | undefined, scope: string | undefined, notify: boolean): EventEdits | undefined {
  const out: EventEdits = {};
  if (f && review.fields) {
    for (const k of ['summary', 'description', 'location', 'start', 'end', 'allDay', 'timezone', 'meet'] as const) {
      if (f[k] !== review.fields[k]) (out as Record<string, unknown>)[k] = f[k];
    }
    if (f.attendees.join(',') !== review.fields.attendees.join(',')) out.attendees = f.attendees;
  }
  if (scope && review.recurring && scope !== review.recurring.scope) out.scope = scope as EventEdits['scope'];
  if (notify !== review.notifyGuests) out.notifyGuests = notify;
  return Object.keys(out).length ? out : undefined;
}

// ─── workspace cards ───────────────────────────────────────────────────────────

export const OUTCOME: Record<string, string> = { allowed: 'Done', always: 'Done, and always allowed', denied: 'Not done', expired: 'Expired' };

/** Only what changed in a sheet edit, keyed by cell. */
export function sheetEditsOf(review: SheetReview, cells: Record<string, string>): SheetEdits | undefined {
  const changed = Object.fromEntries(Object.entries(cells).filter(([k, v]) => review.changes.find((c) => c.cell === k)?.after !== v));
  return Object.keys(changed).length ? { cells: changed } : undefined;
}

/** Only what the person changed in a doc edit. */
export function docEditsOf(review: DocReview, insert: string | undefined, replaceWith: string | undefined, markdown: string | undefined): DocEdits | undefined {
  const edits: DocEdits = {};
  if (insert !== review.insert && insert !== undefined) edits.insert = insert;
  if (replaceWith !== review.replace?.with && replaceWith !== undefined) edits.replaceWith = replaceWith;
  if (markdown !== review.markdown && markdown !== undefined) edits.markdown = markdown;
  return Object.keys(edits).length ? edits : undefined;
}

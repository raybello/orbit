/**
 * What an approval card shows, and lets the person change, for a Gmail, Google Calendar, Google
 * Sheets or Google Docs action. The server builds one of these from the bot's call (and, where the
 * card shows what something looked like before, from a read of it). The person may edit the fields
 * marked editable and approve: what then runs is their version, and the bot is told what changed.
 *
 * `ReviewEdits` are sent back with the decision. Each kind accepts only the fields named in its
 * `*Edits` type; the server validates them before anything runs.
 */

export type ReviewKind = 'email' | 'event' | 'sheet' | 'doc';

/** An email about to be sent: a new message, a draft being sent, a reply or a forward. */
export interface EmailReview {
  kind: 'email';
  action: 'send' | 'send_draft' | 'reply' | 'forward';
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  isHtml: boolean;
  draftId?: string;
  threadId?: string;
  /** False when the fields could not be read in full (e.g. a draft that would not load): the card shows them read-only. */
  editable: boolean;
}
export type EmailEdits = Partial<Pick<EmailReview, 'to' | 'cc' | 'bcc' | 'subject' | 'body'>>;

/** The fields of a calendar event the card shows and edits. Times are ISO strings in `timezone`. */
export interface EventFields {
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  timezone: string;
  attendees: string[];
  meet: boolean;
}

export interface EventReview {
  kind: 'event';
  action: 'create' | 'update' | 'delete' | 'quick_add' | 'remove_attendee' | 'move';
  calendarId: string;
  eventId?: string;
  /** The event as it will be after this action (absent for a delete). */
  fields?: EventFields;
  /** The event as it is now (absent for a create). */
  before?: EventFields;
  /** Set for an event that is part of a recurring series: what the change applies to. */
  recurring?: { scope: 'this' | 'following' | 'all' };
  /** Whether guests get Google's notification email. Shown only when the event has attendees. */
  notifyGuests: boolean;
  editable: boolean;
}
export type EventEdits = Partial<EventFields> & { scope?: 'this' | 'following' | 'all'; notifyGuests?: boolean };

/** One cell that changes: A1 address, value now, value after. */
export interface CellChange { cell: string; before: string; after: string }

export interface SheetReview {
  kind: 'sheet';
  spreadsheetId: string;
  title?: string;
  sheet?: string;
  /** Value writes, cell by cell, capped; `more` counts the ones not listed. */
  changes: CellChange[];
  more: number;
  /** Structural changes and SQL writes, as sentences ("Delete the sheet “Old”"). */
  steps: string[];
  editable: boolean;
}
/** Edited cell values, by A1 address. */
export interface SheetEdits { cells?: Record<string, string> }

export interface DocReview {
  kind: 'doc';
  documentId: string;
  title?: string;
  /** Text added or replacing something, and what it replaces. */
  insert?: string;
  replace?: { find: string; with: string; matchCase: boolean };
  /** For whole-document rewrites: the line diff, prefixed "+ ", "- " or "  ". */
  diff?: string[];
  steps: string[];
  editable: boolean;
}
export interface DocEdits { insert?: string; replaceWith?: string }

export type ReviewPayload = EmailReview | EventReview | SheetReview | DocReview;
export type ReviewEdits = EmailEdits | EventEdits | SheetEdits | DocEdits;

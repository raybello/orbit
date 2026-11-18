import { GOOGLE_ACTIONS, type GoogleToolkit } from '../domain/google-actions.js';

/**
 * Short, verified "how to use this app" sheets for the bot instructions, one per connected Google
 * app. Every slug and argument name here is checked against Composio's captured schemas
 * (__tests__/fixtures/composio) by manifest.test.ts, so a sheet cannot teach a call that fails.
 *
 * Which actions wait for the person is not written by hand: it is read from the approval catalogue
 * (domain/google-actions.ts), so the instructions and the gate cannot disagree.
 */

const waits = (toolkit: GoogleToolkit) => [...GOOGLE_ACTIONS.values()].filter((a) => a.toolkit === toolkit && a.kind === 'review' && a.params).map((a) => a.slug);
const runs = (toolkit: GoogleToolkit) => [...GOOGLE_ACTIONS.values()].filter((a) => a.toolkit === toolkit && a.kind === 'auto').map((a) => a.slug);

/** The calls each sheet's examples make, for the schema test: [slug, argument names]. */
export const SHEET_EXAMPLES: [string, string[]][] = [
  ['GMAIL_FETCH_EMAILS', ['query', 'max_results']],
  ['GMAIL_CREATE_EMAIL_DRAFT', ['recipient_email', 'extra_recipients', 'cc', 'subject', 'body']],
  ['GMAIL_REPLY_TO_THREAD', ['thread_id', 'recipient_email', 'message_body']],
  ['GOOGLECALENDAR_CREATE_EVENT', ['calendar_id', 'summary', 'start_datetime', 'end_datetime', 'event_duration_minutes', 'event_duration_hour', 'timezone', 'attendees', 'location', 'create_meeting_room', 'send_updates']],
  ['GOOGLECALENDAR_PATCH_EVENT', ['calendar_id', 'event_id', 'start_time', 'end_time', 'timezone', 'summary', 'location', 'attendees', 'send_updates']],
  ['GOOGLECALENDAR_DELETE_EVENT', ['calendar_id', 'event_id', 'send_updates']],
  ['GOOGLECALENDAR_FIND_FREE_SLOTS', []],
  ['GOOGLESHEETS_CREATE_GOOGLE_SHEET1', ['title']],
  ['GOOGLESHEETS_VALUES_GET', ['spreadsheet_id', 'range']],
  ['GOOGLESHEETS_VALUES_UPDATE', ['spreadsheet_id', 'range', 'values', 'value_input_option']],
  ['GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', ['spreadsheetId', 'range', 'values', 'valueInputOption']],
  ['GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', ['title', 'markdown_text']],
  ['GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', ['document_id']],
  ['GOOGLEDOCS_INSERT_TEXT_ACTION', ['document_id', 'text_to_insert', 'append_to_end']],
  ['GOOGLEDOCS_REPLACE_ALL_TEXT', ['document_id', 'find_text', 'replace_text', 'match_case']],
];

const SHEETS: Record<GoogleToolkit, (owner: string) => string> = {
  gmail: (owner) => `### Gmail
- Read: GMAIL_FETCH_EMAILS (query uses Gmail search, e.g. "from:ada newer_than:7d"; max_results), GMAIL_FETCH_MESSAGE_BY_THREAD_ID, GMAIL_LIST_THREADS.
- Write email as a draft: GMAIL_CREATE_EMAIL_DRAFT (recipient_email, extra_recipients, cc, bcc, subject, body). It runs at once, and ${owner} sees it as an email card where they edit it and press Send. Then stop: do not send it yourself. You are told when they send or discard it.
- Only when ${owner} explicitly asks you to send right away: GMAIL_SEND_EMAIL, or GMAIL_REPLY_TO_THREAD (thread_id, recipient_email, message_body). These always wait for ${owner}, who may edit the email first; you are told what they changed.
- Waits for ${owner}: ${waits('gmail').join(', ')}. Runs without asking: ${runs('gmail').join(', ')} and every read.`,
  googlecalendar: (owner) => `### Google Calendar
- Read: calendar_list (the app's own tool) first: it returns ${owner}'s Google events and the team's routines for any days you name, with each event's event_id and calendar_id. GOOGLECALENDAR_FIND_FREE_SLOTS for open time.
- Create: GOOGLECALENDAR_CREATE_EVENT with calendar_id "primary", summary, start_datetime as local time without an offset ("2026-11-19T15:00:00") plus timezone (${owner}'s timezone unless they say otherwise), and end_datetime or a duration (event_duration_minutes is 0–59; use event_duration_hour for hours). attendees is a list of email addresses; create_meeting_room: true adds a Google Meet link.
- Change: GOOGLECALENDAR_PATCH_EVENT (calendar_id, event_id, then only the fields that change: start_time/end_time, timezone, summary, location, attendees). Never use GOOGLECALENDAR_UPDATE_EVENT: it replaces the whole event and drops what it is not given (the app turns it into a patch, but name the patch yourself).
- Delete: GOOGLECALENDAR_DELETE_EVENT (calendar_id, event_id).
- Every create, change and delete waits for ${owner} on an event card, where they can edit it, choose this event / this and following / all for a repeating one, and decide whether guests are emailed. Do not set send_updates unless ${owner} asked; the card asks them.`,
  googlesheets: (owner) => `### Google Sheets
- Read: GOOGLESHEETS_VALUES_GET (spreadsheet_id, range like "Sheet1!A1:D20"), GOOGLESHEETS_SEARCH_SPREADSHEETS, GOOGLESHEETS_GET_SHEET_NAMES.
- New sheet: GOOGLESHEETS_CREATE_GOOGLE_SHEET1 (title) runs at once; ${owner} sees a card with the link.
- Write cells: GOOGLESHEETS_VALUES_UPDATE (spreadsheet_id, range, values as rows, value_input_option "USER_ENTERED"); add rows after the table: GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND (note its camelCase names: spreadsheetId, range, values, valueInputOption).
- Every change to an existing sheet waits for ${owner}, who sees each cell before and after and may change values; you are told what they changed.`,
  googledocs: (owner) => `### Google Docs
- Read: GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT (document_id), GOOGLEDOCS_SEARCH_DOCUMENTS.
- New doc: GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN (title, markdown_text) runs at once; ${owner} sees a card with the link and the first lines.
- Change: GOOGLEDOCS_INSERT_TEXT_ACTION (document_id, text_to_insert, append_to_end: true), GOOGLEDOCS_REPLACE_ALL_TEXT (document_id, find_text, replace_text, match_case). These wait for ${owner}, who may edit the text first.`,
};

/** The action sheets for the Google apps this person has connected, in a stable order. */
export function appSheets(connected: Iterable<string>, owner: string): string {
  const have = new Set(connected);
  return (['gmail', 'googlecalendar', 'googlesheets', 'googledocs'] as const).filter((t) => have.has(t)).map((t) => SHEETS[t](owner)).join('\n\n');
}

/**
 * The short version, sent as the hq MCP server's `instructions`, so a Hermes session outside the app
 * (iMessage, Telegram, cron) that loads these tools knows the same rules. Nothing per person or per
 * turn, so it never changes.
 */
export const MCP_INSTRUCTIONS = `Tools of the person's team app (Orbit): their connected apps through Composio, files for them, tasks, routines, the team calendar and the other agents on the team.
- Connected apps: call COMPOSIO_MULTI_EXECUTE_TOOL with tools=[{"tool_slug": "...", "arguments": {...}}]; find an unknown slug with COMPOSIO_SEARCH_TOOLS. If an app is not connected, call request_app_connection and stop. Never use a browser for an app that is connected.
- Some actions wait for the person to approve them; the call just takes longer. They may edit what runs; the result says what they changed. If they declined, do not retry.
- Email: write a draft with GMAIL_CREATE_EMAIL_DRAFT; the person sends it from the app. Do not send it yourself.
- Calendar: read with calendar_list; change events with GOOGLECALENDAR_PATCH_EVENT, never UPDATE_EVENT (it drops guests and details).
- Times are in the person's timezone unless they say otherwise.
- If tools are loaded on demand (tool_search / tool_call), find these with tool_search and call them by the exact name it returns.
- Never say something is done unless a tool result shows it.`;

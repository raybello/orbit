/**
 * What each Gmail, Google Calendar, Google Sheets and Google Docs action is, for approvals.
 *
 *   read    runs at once (it only looks)
 *   auto    runs at once although it writes: it makes something new that nobody else sees yet
 *           (a Gmail draft, a new sheet or doc), so the user reviews the result, not the call
 *   review  waits for the user on a card; `card` names the custom card that shows it, when there is one
 *
 * `allowAlways: false` marks the actions the user decided must ask every time (sending email): a
 * stored "Always allow" is ignored for them and the card does not offer it.
 *
 * `params` lists the argument names the app itself reads or writes for that action (cards, the bot
 * manifest). They are copied from Composio's schemas for toolkit version 20261116_00, whose casing
 * varies between actions; google-actions.test.ts checks every one against the captured schemas in
 * __tests__/fixtures/composio/schemas.
 *
 * Any other action of these four toolkits is classified by name (reads run, everything else is
 * reviewed on the generic card). Actions of other toolkits are not covered here.
 */

export type GoogleToolkit = 'gmail' | 'googlecalendar' | 'googlesheets' | 'googledocs';
export type ActionKind = 'read' | 'auto' | 'review';
export type ReviewCard = 'email' | 'event' | 'sheet' | 'doc';

export interface GoogleAction {
  slug: string;
  toolkit: GoogleToolkit;
  kind: ActionKind;
  card?: ReviewCard;
  allowAlways: boolean;
  params?: readonly string[];
}

/** The toolkit version every slug, param name and fixture here was captured from. */
export const GOOGLE_TOOLKIT_VERSION = '20261116_00';

const PREFIX: Record<string, GoogleToolkit> = { GMAIL_: 'gmail', GOOGLECALENDAR_: 'googlecalendar', GOOGLESHEETS_: 'googlesheets', GOOGLEDOCS_: 'googledocs' };

export function googleToolkitOf(slug: string): GoogleToolkit | undefined {
  const s = slug.toUpperCase();
  for (const [p, tk] of Object.entries(PREFIX)) if (s.startsWith(p)) return tk;
  return undefined;
}

type Entry = [slug: string, kind: ActionKind, opts?: { card?: ReviewCard; allowAlways?: boolean; params?: readonly string[] }];

const reads = (...slugs: string[]): Entry[] => slugs.map((s) => [s, 'read']);

const ENTRIES: Entry[] = [
  // ---- Gmail ----
  ...reads(
    'GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'GMAIL_GET_ATTACHMENT',
    'GMAIL_GET_CONTACTS', 'GMAIL_GET_DRAFT', 'GMAIL_GET_PEOPLE', 'GMAIL_GET_PROFILE', 'GMAIL_LIST_DRAFTS', 'GMAIL_LIST_LABELS',
    'GMAIL_LIST_MESSAGES', 'GMAIL_LIST_THREADS', 'GMAIL_LIST_HISTORY', 'GMAIL_SEARCH_PEOPLE', 'GMAIL_WHO_AM_I',
  ),
  ['GMAIL_CREATE_EMAIL_DRAFT', 'auto', { card: 'email', params: ['recipient_email', 'extra_recipients', 'cc', 'bcc', 'subject', 'body', 'is_html', 'thread_id'] }],
  ['GMAIL_UPDATE_DRAFT', 'auto', { card: 'email', params: ['draft_id', 'recipient_email', 'extra_recipients', 'cc', 'bcc', 'subject', 'body', 'is_html'] }],
  ['GMAIL_SEND_DRAFT', 'review', { card: 'email', allowAlways: false, params: ['draft_id'] }],
  ['GMAIL_SEND_EMAIL', 'review', { card: 'email', allowAlways: false, params: ['recipient_email', 'extra_recipients', 'cc', 'bcc', 'subject', 'body', 'is_html'] }],
  ['GMAIL_REPLY_TO_THREAD', 'review', { card: 'email', allowAlways: false, params: ['thread_id', 'recipient_email', 'extra_recipients', 'cc', 'bcc', 'message_body', 'is_html'] }],
  ['GMAIL_FORWARD_MESSAGE', 'review', { card: 'email', allowAlways: false }],

  // ---- Google Calendar ----
  ...reads(
    'GOOGLECALENDAR_LIST_CALENDARS', 'GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'GOOGLECALENDAR_EVENTS_GET',
    'GOOGLECALENDAR_EVENTS_INSTANCES', 'GOOGLECALENDAR_FIND_EVENT', 'GOOGLECALENDAR_FIND_FREE_SLOTS', 'GOOGLECALENDAR_FREE_BUSY_QUERY',
    'GOOGLECALENDAR_GET_CALENDAR', 'GOOGLECALENDAR_GET_CALENDAR_PROFILE', 'GOOGLECALENDAR_GET_CURRENT_DATE_TIME', 'GOOGLECALENDAR_GET_CURRENT_USER',
    'GOOGLECALENDAR_CALENDAR_LIST_GET', 'GOOGLECALENDAR_COLORS_GET', 'GOOGLECALENDAR_SETTINGS_GET', 'GOOGLECALENDAR_SETTINGS_LIST', 'GOOGLECALENDAR_LIST_SETTINGS',
  ),
  ['GOOGLECALENDAR_CREATE_EVENT', 'review', { card: 'event', params: ['calendar_id', 'summary', 'description', 'location', 'start_datetime', 'end_datetime', 'event_duration_minutes', 'timezone', 'attendees', 'recurrence', 'send_updates', 'create_meeting_room'] }],
  ['GOOGLECALENDAR_QUICK_ADD', 'review', { card: 'event', params: ['calendar_id', 'text', 'send_updates'] }],
  ['GOOGLECALENDAR_PATCH_EVENT', 'review', { card: 'event', params: ['calendar_id', 'event_id', 'summary', 'description', 'location', 'start_time', 'end_time', 'timezone', 'attendees', 'recurrence', 'send_updates', 'conference_data'] }],
  ['GOOGLECALENDAR_UPDATE_EVENT', 'review', { card: 'event', params: ['calendar_id', 'event_id', 'summary', 'start_datetime', 'end_datetime', 'timezone', 'send_updates'] }],
  ['GOOGLECALENDAR_DELETE_EVENT', 'review', { card: 'event', params: ['calendar_id', 'event_id', 'send_updates'] }],
  ['GOOGLECALENDAR_REMOVE_ATTENDEE', 'review', { card: 'event', params: ['calendar_id', 'event_id', 'attendee_email'] }],
  ['GOOGLECALENDAR_EVENTS_MOVE', 'review', { card: 'event' }],

  // ---- Google Sheets ----
  ...reads(
    'GOOGLESHEETS_VALUES_GET', 'GOOGLESHEETS_BATCH_GET', 'GOOGLESHEETS_GET_BATCH_VALUES', 'GOOGLESHEETS_GET_SHEET_NAMES', 'GOOGLESHEETS_GET_SPREADSHEET_INFO',
    'GOOGLESHEETS_GET_SPREADSHEET_BY_DATA_FILTER', 'GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_GET_BY_DATA_FILTER', 'GOOGLESHEETS_SEARCH_SPREADSHEETS',
    'GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW', 'GOOGLESHEETS_QUERY_TABLE', 'GOOGLESHEETS_LIST_TABLES', 'GOOGLESHEETS_GET_TABLE_SCHEMA',
    'GOOGLESHEETS_FIND_WORKSHEET_BY_TITLE', 'GOOGLESHEETS_AGGREGATE_COLUMN_DATA', 'GOOGLESHEETS_LIST_CHARTS', 'GOOGLESHEETS_GET_DRIVE_FILE_METADATA',
    'GOOGLESHEETS_GET_CONDITIONAL_FORMAT_RULES', 'GOOGLESHEETS_GET_DATA_VALIDATION_RULES', 'GOOGLESHEETS_SEARCH_DEVELOPER_METADATA',
  ),
  ['GOOGLESHEETS_CREATE_GOOGLE_SHEET1', 'auto', { card: 'sheet', params: ['title'] }],
  ['GOOGLESHEETS_SHEET_FROM_JSON', 'auto', { card: 'sheet' }],
  ['GOOGLESHEETS_VALUES_UPDATE', 'review', { card: 'sheet', params: ['spreadsheet_id', 'range', 'values', 'value_input_option'] }],
  ['GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', 'review', { card: 'sheet', params: ['spreadsheetId', 'range', 'values', 'valueInputOption'] }],
  ['GOOGLESHEETS_UPDATE_VALUES_BATCH', 'review', { card: 'sheet', params: ['spreadsheet_id', 'data', 'valueInputOption'] }],
  ['GOOGLESHEETS_BATCH_UPDATE', 'review', { card: 'sheet', params: ['spreadsheet_id', 'sheet_name', 'first_cell_location', 'values'] }],
  ['GOOGLESHEETS_EXECUTE_SQL', 'review', { card: 'sheet', params: ['spreadsheet_id', 'sql', 'dry_run'] }],
  ['GOOGLESHEETS_ADD_SHEET', 'review', { card: 'sheet', params: ['spreadsheet_id', 'properties'] }],
  ...([
    'GOOGLESHEETS_UPSERT_ROWS', 'GOOGLESHEETS_CREATE_SPREADSHEET_ROW', 'GOOGLESHEETS_CREATE_SPREADSHEET_COLUMN', 'GOOGLESHEETS_CLEAR_VALUES',
    'GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_CLEAR', 'GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER', 'GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER',
    'GOOGLESHEETS_DELETE_SHEET', 'GOOGLESHEETS_INSERT_DIMENSION', 'GOOGLESHEETS_DELETE_DIMENSION', 'GOOGLESHEETS_APPEND_DIMENSION',
    'GOOGLESHEETS_FIND_REPLACE', 'GOOGLESHEETS_SORT_RANGE', 'GOOGLESHEETS_UPDATE_SHEET_PROPERTIES',
  ].map((s): Entry => [s, 'review', { card: 'sheet' }])),

  // ---- Google Docs ----
  ...reads(
    'GOOGLEDOCS_GET_DOCUMENT_BY_ID', 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', 'GOOGLEDOCS_SEARCH_DOCUMENTS', 'GOOGLEDOCS_GET_DOCS_DRIVE_FILE_METADATA',
    'GOOGLEDOCS_GET_DOCUMENT_END_INDEX', 'GOOGLEDOCS_GET_DOCS_SPREADSHEET_VALUES', 'GOOGLEDOCS_LIST_SPREADSHEET_CHARTS',
  ),
  ['GOOGLEDOCS_CREATE_DOCUMENT', 'auto', { card: 'doc' }],
  ['GOOGLEDOCS_CREATE_DOCUMENT2', 'auto', { card: 'doc' }],
  ['GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', 'auto', { card: 'doc', params: ['title', 'markdown_text'] }],
  ['GOOGLEDOCS_COPY_DOCUMENT', 'auto', { card: 'doc' }],
  ['GOOGLEDOCS_INSERT_TEXT_ACTION', 'review', { card: 'doc', params: ['document_id', 'text_to_insert', 'append_to_end', 'insertion_index'] }],
  ['GOOGLEDOCS_REPLACE_ALL_TEXT', 'review', { card: 'doc', params: ['document_id', 'find_text', 'replace_text', 'match_case'] }],
  ['GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN', 'review', { card: 'doc', params: ['id', 'markdown'] }],
  ...([
    'GOOGLEDOCS_UPDATE_DOCUMENT_SECTION_MARKDOWN', 'GOOGLEDOCS_UPDATE_DOCUMENT_BATCH', 'GOOGLEDOCS_UPDATE_EXISTING_DOCUMENT',
    'GOOGLEDOCS_DELETE_CONTENT_RANGE', 'GOOGLEDOCS_DELETE_TAB', 'GOOGLEDOCS_DELETE_HEADER', 'GOOGLEDOCS_DELETE_FOOTER',
  ].map((s): Entry => [s, 'review', { card: 'doc' }])),
];

export const GOOGLE_ACTIONS: ReadonlyMap<string, GoogleAction> = new Map(
  ENTRIES.map(([slug, kind, opts]) => {
    const toolkit = googleToolkitOf(slug);
    if (!toolkit) throw new Error(`${slug} is not a Gmail, Calendar, Sheets or Docs action`);
    return [slug, { slug, toolkit, kind, allowAlways: opts?.allowAlways ?? true, ...(opts?.card ? { card: opts.card } : {}), ...(opts?.params ? { params: opts.params } : {}) }];
  }),
);

/**
 * Argument names agents mix up between sibling actions. Gmail's send and draft actions take `body`
 * and its reply takes `message_body`; Composio drops a name the action does not know, so a send
 * named `message_body` goes out with an empty body.
 */
const ALIASES: readonly (readonly [string, string])[] = [['body', 'message_body']];

/** The arguments under the names this action takes. Unknown actions and unambiguous calls are left as they are. */
export function canonicalArgs(slug: string, args: Record<string, unknown>): Record<string, unknown> {
  const params = GOOGLE_ACTIONS.get(slug.toUpperCase())?.params;
  if (!params) return args;
  let out = args;
  for (const [a, b] of ALIASES) {
    const [want, other] = params.includes(a) && !params.includes(b) ? [a, b] : params.includes(b) && !params.includes(a) ? [b, a] : [null, null];
    if (!want || !other || !(other in out) || out[want] !== undefined) continue;
    const { [other]: value, ...rest } = out;
    out = { ...rest, [want]: value };
  }
  return out;
}

/** The name-based reading every other app gets: reads run, everything else asks. */
const READ_RE = /_(GET|LIST|SEARCH|FETCH|FIND|READ|RETRIEVE|QUERY|LOOKUP|CHECK|DESCRIBE|VIEW|COUNT)(_|$)/;
export const isReadOnlySlug = (slug: string) => READ_RE.test(slug.toUpperCase());

/**
 * A single SELECT, nothing after it. Google Sheets SQL through Composio can also INSERT, UPDATE and
 * DELETE rows, so anything else is a write. Deliberately strict: a query this rejects is only asked about.
 */
export function isSelectOnly(sql: unknown): boolean {
  if (typeof sql !== 'string') return false;
  const s = sql.trim().replace(/;\s*$/, '');
  return /^select\b/i.test(s) && !s.includes(';');
}

/**
 * How one call to a Google action is handled, given its arguments. Undefined for any slug outside
 * the four Google toolkits.
 */
export function classifyGoogleCall(slug: string, args: unknown): GoogleAction | undefined {
  const upper = slug.toUpperCase();
  const toolkit = googleToolkitOf(upper);
  if (!toolkit) return undefined;
  const known = GOOGLE_ACTIONS.get(upper);
  if (known?.slug === 'GOOGLESHEETS_EXECUTE_SQL' && isSelectOnly((args as { sql?: unknown } | null)?.sql)) {
    return { ...known, kind: 'read' };
  }
  if (known) return known;
  return { slug: upper, toolkit, kind: isReadOnlySlug(upper) ? 'read' : 'review', allowAlways: true };
}

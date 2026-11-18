#!/usr/bin/env node
/**
 * Ground truth for the workspace-approvals work (docs/plans/workspace-approvals.md, phase 0).
 *
 * Records what Composio really accepts and returns for every Gmail, Calendar, Sheets and Docs action
 * the plan relies on, as redacted JSON fixtures the server tests read.
 *
 *   node scripts/composio-shapes.mjs schemas   # input schemas + the tool router's meta-tool schemas (no Google account needed)
 *   node scripts/composio-shapes.mjs connect   # prints sign-in links for the eval user; open them signed in to the TEST Google account
 *   node scripts/composio-shapes.mjs status    # which apps the eval user has connected
 *   node scripts/composio-shapes.mjs capture   # runs the actions against the test account and saves redacted results
 *
 * Every call runs as the Composio user EVAL_COMPOSIO_USER (default `orbit-eval-test`), never as a real
 * Orbit user. `capture` refuses to run unless all four apps are connected for that user, and only
 * writes to items it creates itself: drafts and email go to the test account's own address, events
 * are created on its primary calendar and deleted, sheets and docs are created with an "Orbit eval"
 * title (Composio's Sheets and Docs toolkits cannot delete files, so those stay in the test Drive).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'apps/server/src/__tests__/fixtures/composio');
const USER = process.env.EVAL_COMPOSIO_USER || 'orbit-eval-test';
const TOOLKITS = ['gmail', 'googlecalendar', 'googlesheets', 'googledocs'];
const REST = 'https://backend.composio.dev/api/v3.1';

function readEnvKey() {
  if (process.env.COMPOSIO_API_KEY) return process.env.COMPOSIO_API_KEY;
  const line = fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').find((l) => l.startsWith('COMPOSIO_API_KEY='));
  return line ? line.slice('COMPOSIO_API_KEY='.length).trim().replace(/^"|"$/g, '') : '';
}
const KEY = readEnvKey();
if (KEY.length < 10) { console.error('COMPOSIO_API_KEY is not set (env or orbit-app/.env).'); process.exit(1); }

const requireServer = createRequire(path.join(root, 'apps/server/package.json'));
const core = await import(pathToFileURL(requireServer.resolve('@composio/core')).href);

async function rest(p) {
  const res = await fetch(`${REST}${p}`, { headers: { 'x-api-key': KEY } });
  if (!res.ok) throw new Error(`${p}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// The slugs the plan depends on, by toolkit.
const SLUGS = {
  gmail: ['GMAIL_GET_PROFILE', 'GMAIL_WHO_AM_I', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_GET_DRAFT', 'GMAIL_UPDATE_DRAFT', 'GMAIL_SEND_DRAFT', 'GMAIL_DELETE_DRAFT', 'GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD'],
  googlecalendar: ['GOOGLECALENDAR_LIST_CALENDARS', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'GOOGLECALENDAR_EVENTS_GET', 'GOOGLECALENDAR_EVENTS_INSTANCES', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_UPDATE_EVENT', 'GOOGLECALENDAR_PATCH_EVENT', 'GOOGLECALENDAR_DELETE_EVENT', 'GOOGLECALENDAR_QUICK_ADD', 'GOOGLECALENDAR_REMOVE_ATTENDEE'],
  googlesheets: ['GOOGLESHEETS_CREATE_GOOGLE_SHEET1', 'GOOGLESHEETS_VALUES_GET', 'GOOGLESHEETS_VALUES_UPDATE', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', 'GOOGLESHEETS_UPDATE_VALUES_BATCH', 'GOOGLESHEETS_BATCH_UPDATE', 'GOOGLESHEETS_EXECUTE_SQL', 'GOOGLESHEETS_ADD_SHEET'],
  googledocs: ['GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', 'GOOGLEDOCS_INSERT_TEXT_ACTION', 'GOOGLEDOCS_REPLACE_ALL_TEXT', 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN'],
};

const write = (rel, data) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return path.relative(root, file);
};

// ---------- redaction ----------
// Fixtures are committed, so nothing that identifies the test account survives: email addresses,
// Google ids, links and long free text are replaced with stable placeholders (the same id always
// maps to the same placeholder, so cross-references inside a fixture still line up).

const placeholders = new Map();
const stable = (kind, value) => {
  const k = `${kind}:${value}`;
  if (!placeholders.has(k)) placeholders.set(k, `${kind}_${[...placeholders.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}`);
  return placeholders.get(k);
};
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ID_KEY = /(^id$|Id$|_id$|^etag$|^iCalUID$|token|^historyId$|^threadId$|^messageId$|^sequence$)/i;
const URL_KEY = /(link|url|uri)$/i;

const PERSON_KEY = /^(name|given_name|family_name|displayName|picture)$/;
const ALREADY = /^(id|link|person|name)_\d+$/;

export function redact(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    // A person record (an id-token profile, an attendee, an organizer): their names go too.
    const person = 'email' in value || 'sub' in value || 'emailAddress' in value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      if (typeof v === 'string' && v && (k === 'displayName' || (person && PERSON_KEY.test(k)))) return [k, ALREADY.test(v) ? v : stable('name', v)];
      if (k === 'sub' && typeof v === 'string') return [k, stable('id', v)];
      return [k, redact(v, k)];
    }));
  }
  if (typeof value !== 'string') return value;
  if (ALREADY.test(value)) return value;
  if (ID_KEY.test(key) && value) return stable('id', value);
  // "Name <address>" in mail headers.
  value = value.replace(/(^|,\s*)"?([^"<,]{1,80}?)"?\s*<([^>]+)>/g, (_m, sep, name, addr) => `${sep}${stable('name', name.trim())} <${addr}>`);
  if (URL_KEY.test(key) && /^https?:/.test(value)) return `https://example.test/${stable('link', value)}`;
  let s = value.replace(EMAIL, (m) => (m.endsWith('.calendar.google.com') ? 'calendar@group.example.test' : `${stable('person', m.toLowerCase())}@example.test`));
  if (/^[A-Za-z0-9+/=_-]{120,}$/.test(s)) s = `<base64 ${s.length} chars>`;
  else if (s.length > 600) s = `${s.slice(0, 600)}…(${s.length} chars)`;
  return s;
}

// ---------- modes ----------

async function schemas() {
  const summary = {};
  for (const [toolkit, slugs] of Object.entries(SLUGS)) {
    for (const slug of slugs) {
      const t = await rest(`/tools/${slug}`);
      summary[slug] = { toolkit, version: t.version, required: t.input_parameters?.required ?? [], params: Object.keys(t.input_parameters?.properties ?? {}) };
      write(`schemas/${slug}.json`, { slug, version: t.version, description: t.description, input_parameters: t.input_parameters, output_parameters: t.output_parameters });
    }
  }
  const composio = new core.Composio({ apiKey: KEY });
  const session = await composio.create(USER, { manageConnections: false });
  const meta = await session.tools();
  write('schemas/_meta-tools.json', meta);
  write('schemas/_summary.json', summary);
  const versions = Object.fromEntries(Object.entries(summary).map(([, s]) => [s.toolkit, s.version]));
  console.log(`Saved ${Object.keys(summary).length} input schemas and ${Array.isArray(meta) ? meta.length : '?'} meta-tool schemas. Toolkit versions:`, versions);
}

async function connected() {
  const r = await rest(`/connected_accounts?user_ids=${encodeURIComponent(USER)}&statuses=ACTIVE&limit=50`);
  return new Set((r.items ?? []).map((i) => i.toolkit?.slug).filter(Boolean));
}

async function connect() {
  const composio = new core.Composio({ apiKey: KEY });
  const session = await composio.create(USER, { manageConnections: false });
  const have = await connected();
  console.log(`Composio user: ${USER}. Sign in with the TEST Google account only.\n`);
  for (const tk of TOOLKITS) {
    if (have.has(tk)) { console.log(`${tk}: already connected`); continue; }
    const req = await session.authorize(tk, { callbackUrl: 'https://example.test/connected' });
    console.log(`${tk}: ${req.redirectUrl}`);
  }
  // Composio expires a link about 10 minutes after it is made if nobody starts signing in, so this
  // waits while the person signs in and says which ones finished. Run it again for fresh links.
  console.log('\nThe links expire about 10 minutes from now if unused. Waiting for sign-ins…');
  const deadline = Date.now() + 15 * 60_000;
  let done = new Set([...have]);
  while (Date.now() < deadline && done.size < TOOLKITS.length) {
    await new Promise((r) => setTimeout(r, 10_000));
    const now = await connected();
    for (const tk of TOOLKITS) if (now.has(tk) && !done.has(tk)) console.log(`${tk}: connected`);
    done = now;
  }
  const left = TOOLKITS.filter((t) => !done.has(t));
  console.log(left.length ? `Still not connected: ${left.join(', ')}. Run "connect" again for fresh links.` : 'All four connected.');
}

async function status() {
  const have = await connected();
  for (const tk of TOOLKITS) console.log(`${tk}: ${have.has(tk) ? 'connected' : 'not connected'}`);
  return have;
}

async function capture() {
  const have = await connected();
  const missing = TOOLKITS.filter((t) => !have.has(t));
  if (missing.length) { console.error(`Not connected for ${USER}: ${missing.join(', ')}. Run "connect" first.`); process.exit(1); }

  const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'schemas/_summary.json'), 'utf8'));
  const toolkitVersions = Object.fromEntries(Object.values(summary).map((s) => [s.toolkit, s.version]));
  const composio = new core.Composio({ apiKey: KEY, toolkitVersions });
  const results = [];
  const created = { drafts: [], events: [] };

  /** Run one action, save its redacted request and response, and return the raw data for the next step. */
  async function run(name, slug, args) {
    const started = Date.now();
    let res;
    try {
      res = await composio.tools.execute(slug, { userId: USER, arguments: args });
    } catch (e) {
      res = { successful: false, error: String(e?.message ?? e), data: null };
    }
    const ok = res.successful !== false && !res.error;
    write(`responses/${name}.json`, { slug, ok, ms: Date.now() - started, request: redact(args), response: redact({ data: res.data, error: res.error ?? null }) });
    results.push({ name, slug, ok, error: ok ? undefined : String(res.error).slice(0, 200) });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${slug})${ok ? '' : `: ${String(res.error).slice(0, 160)}`}`);
    return ok ? res.data : null;
  }
  const dig = (o, ...keys) => { for (const k of keys) { const hit = deepFind(o, k); if (hit !== undefined) return hit; } return undefined; };
  function deepFind(o, key) {
    if (!o || typeof o !== 'object') return undefined;
    if (key in o && o[key] !== null && o[key] !== undefined && typeof o[key] !== 'object') return o[key];
    for (const v of Object.values(o)) { const r = deepFind(v, key); if (r !== undefined) return r; }
    return undefined;
  }

  const stamp = new Date().toISOString().slice(0, 16);
  const tomorrow = (h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); return d; };
  const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  try {
    // ----- Gmail -----
    const profile = await run('gmail-get-profile', 'GMAIL_GET_PROFILE', {});
    await run('gmail-who-am-i', 'GMAIL_WHO_AM_I', {});
    const me = dig(profile, 'emailAddress', 'email');
    if (!me) throw new Error('Could not read the test account address from GMAIL_GET_PROFILE.');

    const draft = await run('gmail-create-draft', 'GMAIL_CREATE_EMAIL_DRAFT', { recipient_email: me, subject: `Orbit eval draft ${stamp}`, body: 'First version of the draft.' });
    const draftId = dig(draft, 'draft_id', 'id');
    if (draftId) {
      created.drafts.push(draftId);
      await run('gmail-get-draft', 'GMAIL_GET_DRAFT', { draft_id: draftId });
      await run('gmail-update-draft', 'GMAIL_UPDATE_DRAFT', { draft_id: draftId, subject: `Orbit eval draft ${stamp} (edited)`, body: 'Edited version of the draft.' });
      await run('gmail-send-draft', 'GMAIL_SEND_DRAFT', { draft_id: draftId });
      created.drafts.pop();
    }
    const throwaway = await run('gmail-create-draft-2', 'GMAIL_CREATE_EMAIL_DRAFT', { recipient_email: me, subject: `Orbit eval discard ${stamp}`, body: 'To be deleted.' });
    const throwawayId = dig(throwaway, 'draft_id', 'id');
    if (throwawayId) await run('gmail-delete-draft', 'GMAIL_DELETE_DRAFT', { draft_id: throwawayId });

    const sent = await run('gmail-send-email', 'GMAIL_SEND_EMAIL', { recipient_email: me, subject: `Orbit eval send ${stamp}`, body: 'Sent directly by the shapes script.' });
    const threadId = dig(sent, 'threadId', 'thread_id');
    if (threadId) await run('gmail-reply-to-thread', 'GMAIL_REPLY_TO_THREAD', { thread_id: threadId, recipient_email: me, message_body: 'A reply in the same thread.' });

    // ----- Calendar -----
    await run('gcal-list-calendars', 'GOOGLECALENDAR_LIST_CALENDARS', {});
    const ev = await run('gcal-create-event', 'GOOGLECALENDAR_CREATE_EVENT', {
      calendar_id: 'primary', summary: `Orbit eval event ${stamp}`, start_datetime: local(tomorrow(15)), event_duration_minutes: 30, timezone: tz,
      description: 'Created by the shapes script.', location: 'Room 1', attendees: ['orbit-eval-attendee@example.com'], send_updates: 'none', create_meeting_room: true,
    });
    const eventId = dig(ev, 'id', 'event_id');
    if (eventId) {
      created.events.push(eventId);
      await run('gcal-events-get', 'GOOGLECALENDAR_EVENTS_GET', { calendar_id: 'primary', event_id: eventId });
      await run('gcal-patch-event', 'GOOGLECALENDAR_PATCH_EVENT', { calendar_id: 'primary', event_id: eventId, start_time: local(tomorrow(16)), end_time: local(tomorrow(16, 30)), timezone: tz, send_updates: 'none' });
      await run('gcal-update-event', 'GOOGLECALENDAR_UPDATE_EVENT', { calendar_id: 'primary', event_id: eventId, summary: `Orbit eval event ${stamp} (updated)`, start_datetime: local(tomorrow(16)), event_duration_minutes: 45, timezone: tz, send_updates: 'none' });
      await run('gcal-remove-attendee', 'GOOGLECALENDAR_REMOVE_ATTENDEE', { calendar_id: 'primary', event_id: eventId, attendee_email: 'orbit-eval-attendee@example.com' });
    }
    const series = await run('gcal-create-recurring', 'GOOGLECALENDAR_CREATE_EVENT', {
      calendar_id: 'primary', summary: `Orbit eval weekly ${stamp}`, start_datetime: local(tomorrow(9)), event_duration_minutes: 15, timezone: tz,
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'], send_updates: 'none',
    });
    const seriesId = dig(series, 'id', 'event_id');
    if (seriesId) {
      created.events.push(seriesId);
      const inst = await run('gcal-events-instances', 'GOOGLECALENDAR_EVENTS_INSTANCES', { calendarId: 'primary', eventId: seriesId, maxResults: 4 });
      const second = Array.isArray(inst?.items) ? inst.items[1] : Array.isArray(inst?.events) ? inst.events[1] : undefined;
      if (second?.id) await run('gcal-patch-instance', 'GOOGLECALENDAR_PATCH_EVENT', { calendar_id: 'primary', event_id: second.id, summary: `Orbit eval weekly ${stamp} (one instance)`, send_updates: 'none' });
    }
    const quick = await run('gcal-quick-add', 'GOOGLECALENDAR_QUICK_ADD', { calendar_id: 'primary', text: `Orbit eval quick add ${stamp} tomorrow at 11am`, send_updates: 'none' });
    const quickId = dig(quick, 'id', 'event_id');
    if (quickId) created.events.push(quickId);

    const from = new Date(); from.setDate(from.getDate() - 1);
    const to = new Date(); to.setDate(to.getDate() + 30);
    await run('gcal-list-all-summary', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', { time_min: from.toISOString(), time_max: to.toISOString(), single_events: true, show_deleted: true, q: 'Orbit eval' });
    await run('gcal-list-all-full', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', { time_min: from.toISOString(), time_max: to.toISOString(), single_events: true, show_deleted: true, q: 'Orbit eval', response_detail: 'full' });

    // ----- Sheets -----
    const sheet = await run('sheets-create', 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1', { title: `Orbit eval sheet ${stamp}` });
    const sheetId = dig(sheet, 'spreadsheetId', 'spreadsheet_id', 'id');
    if (sheetId) {
      await run('sheets-values-update', 'GOOGLESHEETS_VALUES_UPDATE', { spreadsheet_id: sheetId, range: 'Sheet1!A1:C2', value_input_option: 'USER_ENTERED', values: [['Name', 'Count', 'Note'], ['alpha', 1, 'first']], include_values_in_response: true });
      await run('sheets-values-get', 'GOOGLESHEETS_VALUES_GET', { spreadsheet_id: sheetId, range: 'Sheet1!A1:C10' });
      await run('sheets-values-append', 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', { spreadsheetId: sheetId, range: 'Sheet1!A1', valueInputOption: 'USER_ENTERED', values: [['beta', 2, 'second'], ['gamma', 3, 'third']], includeValuesInResponse: true });
      await run('sheets-update-values-batch', 'GOOGLESHEETS_UPDATE_VALUES_BATCH', { spreadsheet_id: sheetId, valueInputOption: 'USER_ENTERED', data: [{ range: 'Sheet1!B2', values: [[10]] }, { range: 'Sheet1!C3', values: [['changed']] }], includeValuesInResponse: true });
      await run('sheets-batch-update', 'GOOGLESHEETS_BATCH_UPDATE', { spreadsheet_id: sheetId, sheet_name: 'Sheet1', first_cell_location: 'E1', values: [['batch', 'write']], include_values_in_response: true });
      await run('sheets-add-sheet', 'GOOGLESHEETS_ADD_SHEET', { spreadsheet_id: sheetId, properties: { title: 'Second' } });
      await run('sheets-execute-sql-select', 'GOOGLESHEETS_EXECUTE_SQL', { spreadsheet_id: sheetId, sql: 'SELECT * FROM "Sheet1" LIMIT 5', dry_run: true });
    }

    // ----- Docs -----
    const doc = await run('docs-create-markdown', 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', { title: `Orbit eval doc ${stamp}`, markdown_text: '# Weekly notes\n\n- First point\n- Second point\n\nClosing line.' });
    const docId = dig(doc, 'documentId', 'document_id', 'id');
    if (docId) {
      await run('docs-get-plaintext', 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', { document_id: docId });
      await run('docs-insert-text', 'GOOGLEDOCS_INSERT_TEXT_ACTION', { document_id: docId, text_to_insert: '\nAppended by the shapes script.', append_to_end: true });
      await run('docs-replace-all-text', 'GOOGLEDOCS_REPLACE_ALL_TEXT', { document_id: docId, find_text: 'Second point', replace_text: 'Second point (revised)', match_case: true });
      await run('docs-update-markdown', 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN', { id: docId, markdown: '# Weekly notes\n\nReplaced in full.' });
      await run('docs-get-plaintext-after', 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT', { document_id: docId });
    }

    // ----- The tool router path the bots use -----
    const session = await new core.Composio({ apiKey: KEY }).create(USER, { manageConnections: false });
    const multi = { tools: [{ tool_slug: 'GMAIL_GET_PROFILE', arguments: {} }, { tool_slug: 'GOOGLECALENDAR_LIST_CALENDARS', arguments: { max_results: 2 } }] };
    let routed;
    try { routed = await session.execute('COMPOSIO_MULTI_EXECUTE_TOOL', multi); } catch (e) { routed = { error: String(e?.message ?? e) }; }
    write('responses/router-multi-execute.json', { request: multi, response: redact(routed) });
    console.log(`${routed?.error ? 'FAIL' : 'ok  '} router-multi-execute (COMPOSIO_MULTI_EXECUTE_TOOL)`);
  } finally {
    // Clean up what can be cleaned up, even after a failure.
    for (const id of created.drafts) await run(`cleanup-draft-${id.slice(-4)}`, 'GMAIL_DELETE_DRAFT', { draft_id: id });
    for (const [i, id] of created.events.entries()) await run(i === 0 ? 'gcal-delete-event' : `cleanup-event-${i}`, 'GOOGLECALENDAR_DELETE_EVENT', { calendar_id: 'primary', event_id: id, send_updates: 'none' });
    write('responses/_index.json', results);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} calls succeeded. Fixtures in ${path.relative(root, OUT)}/responses.`);
  if (failed.length) process.exitCode = 1;
}

/** Re-run redaction over saved responses, for when the rules above get stricter. Placeholders are kept. */
async function reredact() {
  const dir = path.join(OUT, 'responses');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    write(`responses/${f}`, redact(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
  }
  console.log('Re-redacted', dir);
}

const mode = process.argv[2];
const modes = { schemas, connect, status, capture, reredact };
if (!modes[mode]) { console.error('Usage: node scripts/composio-shapes.mjs <schemas|connect|status|capture>'); process.exit(1); }
await modes[mode]();

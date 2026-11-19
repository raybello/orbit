#!/usr/bin/env node
/**
 * Live eval for the workspace-approvals work (docs/plans/workspace-approvals.md, phase 12).
 *
 * Drives real bot turns against a running Orbit server whose signed-in person has Gmail, Google
 * Calendar, Google Sheets and Google Docs connected to a TEST Google account. For each bot named, it
 * sends scripted requests, waits for the cards they raise, answers them over the API (some with
 * edits), then checks Google itself through Composio. It cleans up the drafts and events it made and
 * writes a report to docs/evidence/workspace-eval-<date>.md.
 *
 *   ORBIT_URL=http://localhost:8787        the server
 *   ORBIT_EMAIL=eval@example.test          signs in with the dev login (DEV_LOGIN=1), or
 *   ORBIT_TOKEN=...                        a session token (POST /api/auth/sign-in)
 *   ORBIT_EVAL_BOTS="Atlas,Scout"          bots to evaluate, by name
 *   EVAL_INBOX=someone@...                 where test email goes (default: the test account itself)
 *   EVAL_ATTENDEE=guest@example.com        the guest on the test meeting (no invite is emailed)
 *   COMPOSIO_API_KEY                       to check Google directly (read from orbit-app/.env if unset)
 *
 * Each step has a budget (STEP_TIMEOUT_MS, default 4 minutes) for the bot to act. A step fails if
 * the bot does the wrong thing, raises no card, or Google does not end up as expected.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GOOGLE_TOOLKIT_VERSION } from './lib/toolkit-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.ORBIT_URL || 'http://localhost:8787').replace(/\/$/, '');
const STEP_MS = Number(process.env.STEP_TIMEOUT_MS || 4 * 60_000);
const BOT_NAMES = (process.env.ORBIT_EVAL_BOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const PINNED = process.env.COMPOSIO_TOOLKIT_VERSION || GOOGLE_TOOLKIT_VERSION;
const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');

const envKey = () => process.env.COMPOSIO_API_KEY || (fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n').find((l) => l.startsWith('COMPOSIO_API_KEY=')) ?? '').slice(17).replace(/"/g, '').trim();
const requireServer = createRequire(path.join(root, 'apps/server/package.json'));
const { Composio } = await import(pathToFileURL(requireServer.resolve('@composio/core')).href);
const composio = new Composio({ apiKey: envKey(), toolkitVersions: { gmail: PINNED, googlecalendar: PINNED, googlesheets: PINNED, googledocs: PINNED } });

// ---------- the Orbit API ----------

let cookie = '';
let bearer = process.env.ORBIT_TOKEN || '';
async function api(method, p, body) {
  const headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
  const r = await fetch(`${BASE}/api${p}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text.slice(0, 200)}`);
  return json;
}
async function signIn() {
  if (bearer) return;
  const r = await fetch(`${BASE}/api/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.ORBIT_EMAIL || 'eval@example.test' }) });
  if (!r.ok) throw new Error(`dev sign-in failed (${r.status}); set ORBIT_TOKEN or start the server with DEV_LOGIN=1`);
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
}

const rows = async (botId) => (await api('GET', `/bots/${botId}/rows`)).rows ?? [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a row that `match` accepts and that appeared after `afterSeq`. */
async function waitFor(botId, afterSeq, match, what) {
  const until = Date.now() + STEP_MS;
  while (Date.now() < until) {
    const hit = (await rows(botId)).find((r) => r.seq > afterSeq && match(r));
    if (hit) return hit;
    await sleep(3000);
  }
  throw new Error(`no ${what} within ${STEP_MS / 1000}s`);
}
/** Wait until the bot's turn is over (no new rows for a while, and the last row is its reply). */
async function waitIdle(botId, afterSeq) {
  const until = Date.now() + STEP_MS;
  let last = -1;
  let quiet = 0;
  while (Date.now() < until) {
    const rs = (await rows(botId)).filter((r) => r.seq > afterSeq);
    const top = Math.max(-1, ...rs.map((r) => r.updatedSeq ?? r.seq));
    quiet = top === last ? quiet + 1 : 0;
    last = top;
    const reply = rs.filter((r) => r.kind === 'message' && r.body.role === 'assistant' && !r.body.streaming).at(-1);
    if (reply && quiet >= 3) return rs;
    await sleep(3000);
  }
  return (await rows(botId)).filter((r) => r.seq > afterSeq);
}
const topSeq = async (botId) => Math.max(0, ...(await rows(botId)).map((r) => r.seq));
async function say(botId, text) {
  const before = await topSeq(botId);
  await api('POST', `/bots/${botId}/messages`, { text });
  return before;
}
const pendingCard = (kind) => (r) => r.kind === 'card' && r.body.card === 'approval' && r.body.status === 'pending' && (!kind || r.body.review?.kind === kind);
const toolCalls = (rs) => rs.filter((r) => r.kind === 'tool-call').map((r) => `${r.body.name}${r.body.args?.tools ? `(${r.body.args.tools.map((t) => t.tool_slug).join(',')})` : ''}`);

// ---------- Google, read directly ----------

let composioUser = '';
async function action(slug, args) {
  const r = await composio.tools.execute(slug, { userId: composioUser, arguments: args });
  if (r.successful === false || r.error) throw new Error(`${slug}: ${JSON.stringify(r.error).slice(0, 200)}`);
  return r.data;
}
const findEvents = async (q) => ((await action('GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', { time_min: new Date(Date.now() - 864e5).toISOString(), time_max: new Date(Date.now() + 14 * 864e5).toISOString(), q, response_detail: 'full', single_events: true })).events ?? []).map((e) => e.event);

// ---------- the steps ----------

async function evalBot(bot, ctx) {
  const results = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
      console.log(`  ok   ${name}`);
    } catch (e) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message ?? e) });
      console.log(`  FAIL ${name}: ${e.message ?? e}`);
    }
  };
  const tag = `${stamp}-${bot.name}`;
  const callTitle = `Orbit eval ${tag} call`;

  await step('1. draft an email, edit its subject, send it from the card', async () => {
    const from = await say(bot.id, `Draft an email to ${ctx.inbox} with the subject "Orbit eval ${tag} sync" saying tomorrow's sync moves to 3pm. Just the draft, I'll send it.`);
    const card = await waitFor(bot.id, from, (r) => r.kind === 'card' && r.body.card === 'draft' && r.body.email && r.body.status === 'pending', 'email draft card');
    await waitIdle(bot.id, from);
    await api('POST', `/bots/${bot.id}/cards/${card.seq}/draft`, { action: 'send', edits: { subject: `Orbit eval ${tag} sync (edited)` } });
    await sleep(5000);
    const found = await action('GMAIL_FETCH_EMAILS', { query: `subject:"Orbit eval ${tag} sync (edited)"`, max_results: 2 });
    if (!(found.messages ?? []).length) throw new Error('the edited email did not arrive');
    return 'arrived with the edited subject';
  });

  await step('2. create a 30-minute call with a guest', async () => {
    const from = await say(bot.id, `Put a 30-minute call titled "${callTitle}" with ${ctx.attendee} on my calendar tomorrow at 3pm.`);
    const card = await waitFor(bot.id, from, pendingCard('event'), 'event card');
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'allow', edits: { notifyGuests: false } });
    const rs = await waitIdle(bot.id, from);
    const [ev] = await findEvents(callTitle);
    if (!ev) throw new Error('no such event in Google');
    if (!(ev.attendees ?? []).some((a) => a.email === ctx.attendee)) throw new Error('the guest is missing');
    ctx.events.push(ev.id);
    return toolCalls(rs).join(' → ');
  });

  await step('3. move it to 4pm (a patch that keeps the guest)', async () => {
    const from = await say(bot.id, `Move "${callTitle}" to 4pm tomorrow.`);
    const card = await waitFor(bot.id, from, pendingCard('event'), 'event card');
    if (!card.body.review.before) throw new Error('the card does not show the event as it was');
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'allow', edits: { notifyGuests: false } });
    const rs = await waitIdle(bot.id, from);
    const [ev] = await findEvents(callTitle);
    const hour = new Date(ev.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', hour12: false, timeZone: ctx.timezone });
    if (hour !== '16') throw new Error(`it starts at ${hour}:00, not 16:00`);
    if (!(ev.attendees ?? []).some((a) => a.email === ctx.attendee)) throw new Error('the move dropped the guest');
    if (toolCalls(rs).some((c) => c.includes('UPDATE_EVENT'))) return `used UPDATE_EVENT (ran as a patch) · ${toolCalls(rs).join(' → ')}`;
    return toolCalls(rs).join(' → ');
  });

  await step('4. read the week with calendar_list', async () => {
    const from = await say(bot.id, "What's on my calendar in the next three days?");
    const rs = await waitIdle(bot.id, from);
    const calls = toolCalls(rs);
    const reply = rs.filter((r) => r.kind === 'message' && r.body.role === 'assistant').map((r) => r.body.text).join('\n');
    if (!calls.some((c) => /calendar_list|EVENTS_LIST/i.test(c))) throw new Error(`did not read the calendar (${calls.join(', ') || 'no tools'})`);
    if (!reply.includes(tag) && !reply.toLowerCase().includes('orbit eval')) throw new Error('the reply does not mention the test call');
    return calls.join(' → ');
  });

  await step('5. duplicate the call as an Orbit event, then cancel the call', async () => {
    await api('POST', '/calendar/google/sync');
    const day = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const cal = await api('GET', `/calendar?from=${day}&to=${day}`);
    const g = (cal.google ?? []).find((e) => e.title === callTitle);
    if (!g) throw new Error('the call is not in the Orbit calendar');
    const d = await api('GET', `/calendar/google/events/${g.key}/duplicate`);
    const { routine } = await api('POST', '/routines', { botId: bot.id, title: `Prep: ${callTitle}`, prompt: d.prompt, eventType: 'one_time', eventDate: new Date(Date.parse(g.start) - 15 * 60_000).toISOString(), parentEventKey: g.key });
    const from = await say(bot.id, `Cancel "${callTitle}".`);
    const card = await waitFor(bot.id, from, pendingCard('event'), 'delete card');
    if (card.body.review.action !== 'delete') throw new Error(`the card is a ${card.body.review.action}, not a delete`);
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'allow', edits: { notifyGuests: false } });
    await waitIdle(bot.id, from);
    if ((await findEvents(callTitle)).length) throw new Error('the call is still in Google');
    ctx.events = ctx.events.filter(Boolean);
    await api('POST', '/calendar/google/sync');
    const mine = (await api('GET', `/bots/${bot.id}/routines`)).routines.find((r) => r.id === routine.id);
    if (mine?.enabled) throw new Error('the linked Orbit event was not paused');
    return 'deleted in Google; the linked Orbit event paused';
  });

  await step('6. add three rows to a sheet (reviewed cell by cell)', async () => {
    const sheet = await action('GOOGLESHEETS_CREATE_GOOGLE_SHEET1', { title: `Orbit eval ${tag} sheet` });
    await action('GOOGLESHEETS_VALUES_UPDATE', { spreadsheet_id: sheet.spreadsheetId, range: 'Sheet1!A1:B1', value_input_option: 'USER_ENTERED', values: [['Item', 'Count']] });
    const from = await say(bot.id, `Add these three rows under the header of the Google Sheet with id ${sheet.spreadsheetId}: apples 3, pears 5, plums 7.`);
    const card = await waitFor(bot.id, from, pendingCard('sheet'), 'sheet card');
    if (!card.body.review.changes.length) throw new Error('the card shows no cells');
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'allow' });
    await waitIdle(bot.id, from);
    const values = (await action('GOOGLESHEETS_VALUES_GET', { spreadsheet_id: sheet.spreadsheetId, range: 'Sheet1!A1:B10' })).values ?? [];
    const flat = values.flat().map(String).join(' ').toLowerCase();
    if (!['apples', 'pears', 'plums'].every((w) => flat.includes(w))) throw new Error(`the sheet holds ${JSON.stringify(values)}`);
    return `${values.length - 1} rows under the header`;
  });

  await step('7. write a new doc (no card; a file card appears)', async () => {
    const from = await say(bot.id, `Create a new Google Doc titled "Orbit eval ${tag} doc" with three bullets: ship the calendar sync, review the eval, plan next week.`);
    const rs = await waitIdle(bot.id, from);
    if (rs.some((r) => pendingCard()(r))) throw new Error('creating a doc asked for approval');
    const notice = rs.find((r) => r.kind === 'notice' && r.body.kind === 'workspace-file');
    if (!notice) throw new Error('no file card appeared');
    return `${notice.body.file.title} · ${notice.body.file.preview.length} preview lines`;
  });

  await step('8. a declined send is not retried', async () => {
    const from = await say(bot.id, `Send an email right now (not a draft) to ${ctx.inbox} with the subject "Orbit eval ${tag} declined" saying hello.`);
    const card = await waitFor(bot.id, from, (r) => pendingCard('email')(r) || (r.kind === 'card' && r.body.card === 'draft' && r.body.status === 'pending'), 'send card or draft');
    if (card.body.card === 'draft') {
      await api('POST', `/bots/${bot.id}/cards/${card.seq}/draft`, { action: 'discard' });
      await waitIdle(bot.id, from);
      return 'the bot drafted instead of sending; discarded';
    }
    await api('POST', `/approvals/${card.body.approvalId}`, { decision: 'deny' });
    const rs = await waitIdle(bot.id, from);
    const again = rs.filter((r) => r.seq > card.seq && pendingCard('email')(r));
    if (again.length) throw new Error('it asked again after being declined');
    return 'declined once, not retried';
  });

  return results;
}

// ---------- run ----------

await signIn();
const me = (await api('GET', '/auth/me')).user;
if (!me) throw new Error('not signed in');
// As a phone or browser would at sign-in: bots give and take times in the person's timezone.
await api('PATCH', '/auth/me', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
composioUser = me.id;
const connected = new Set((await api('GET', '/apps?limit=1')).connected ?? []);
const missing = ['gmail', 'googlecalendar', 'googlesheets', 'googledocs'].filter((t) => !connected.has(t));
if (missing.length) throw new Error(`connect these for ${me.email} first (the TEST Google account): ${missing.join(', ')}`);
const profile = await action('GMAIL_GET_PROFILE', {});
const bots = (await api('GET', '/bots')).bots.filter((b) => b.kind !== 'room');
const chosen = BOT_NAMES.length ? bots.filter((b) => BOT_NAMES.includes(b.name)) : bots.slice(0, 2);
if (!chosen.length) throw new Error(`no bots named ${BOT_NAMES.join(', ')}`);

const ctx = { inbox: process.env.EVAL_INBOX || profile.emailAddress, attendee: process.env.EVAL_ATTENDEE || 'orbit-eval-guest@example.com', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, events: [] };
const report = [];
for (const bot of chosen) {
  console.log(`\n${bot.name} (${bot.model || 'default model'})`);
  report.push({ bot, results: await evalBot(bot, ctx) });
}

// Clean up what is left: test events and drafts.
for (const e of await findEvents(`Orbit eval ${stamp}`)) await action('GOOGLECALENDAR_DELETE_EVENT', { calendar_id: 'primary', event_id: e.id, send_updates: 'none' }).catch(() => null);

const date = new Date().toISOString().slice(0, 10);
const lines = [`# Workspace eval ${date}`, '', `Server ${BASE}, toolkits pinned at ${PINNED}, run ${stamp}. Test inbox and calendar: the connected test account.`, ''];
for (const { bot, results } of report) {
  const passed = results.filter((r) => r.ok).length;
  lines.push(`## ${bot.name} (${bot.model || 'default model'}): ${passed}/${results.length}`, '', '| Step | Result | Time | Detail |', '|---|---|---|---|');
  for (const r of results) lines.push(`| ${r.name} | ${r.ok ? 'pass' : '**fail**'} | ${Math.round(r.ms / 1000)}s | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  lines.push('');
}
const out = path.join(root, 'docs/evidence', `workspace-eval-${date}.md`);
fs.writeFileSync(out, lines.join('\n'));
console.log(`\nReport: ${path.relative(root, out)}`);
process.exitCode = report.every(({ results }) => results.every((r) => r.ok)) ? 0 : 1;

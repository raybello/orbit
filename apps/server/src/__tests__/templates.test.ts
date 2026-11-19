// api-env must be the FIRST import (see helpers/api-env.ts); everything reading env.ts loads below.
import { cleanupTmpEnv } from './helpers/api-env.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

// Two accounts, each with a primary, plus the copies and installs below: three slots is not enough.
process.env.MAX_BOTS = '20';
process.env.APP_URL = 'http://orbit.test';

const { initSubagents } = await import('../agent/subagents.js');
const { initRooms } = await import('../agent/rooms.js');
initSubagents();
initRooms();

const { Cron } = await import('croner');
const { createApp } = await import('../api/app.js');
const { db } = await import('../db.js');
const { COLORS, SHAPES } = await import('../core/avatar.js');
const { ensureTriggerColumns } = await import('../triggers.js');
const { seedTemplates, templateIdForSlug } = await import('../templates.js');
const { STARTER_TEMPLATES } = await import('../seeds/starter-templates.js');

const app = createApp();
ensureTriggerColumns();

type Json = Record<string, any>;

async function send(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function ok(r: Response, status = 200): Promise<Json> {
  const body = (await r.json()) as Json;
  assert.equal(r.status, status, JSON.stringify(body));
  return body;
}

async function signIn(email: string): Promise<{ cookie: string; primaryId: string }> {
  const r = await send('POST', '/api/auth/dev', { email });
  assert.equal(r.status, 200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  const { bots } = await ok(await send('GET', '/api/bots', undefined, cookie));
  return { cookie, primaryId: bots[0].id };
}

const routinesOf = (botId: string) =>
  db.prepare('SELECT name, schedule, timezone, enabled, trigger_id, trigger_config FROM routines WHERE bot_id=? ORDER BY created_at').all(botId) as Json[];

function addRoutine(botId: string, r: { name: string; schedule: string; timezone?: string; eventType?: string; triggerId?: string; config?: string }) {
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,event_type,trigger_id,trigger_config) VALUES (?,?,?,?,?,?,1,?,?,?,?)')
    .run(`rt_${r.name}`, botId, r.name, `do ${r.name}`, r.schedule, r.timezone ?? 'UTC', Date.now(), r.eventType ?? 'recurring', r.triggerId ?? null, r.config ?? null);
}

test('starter registry: every seed is installable as written', () => {
  const slugs = new Set<string>();
  for (const s of STARTER_TEMPLATES) {
    assert.ok(!slugs.has(s.slug), `duplicate slug ${s.slug}`);
    slugs.add(s.slug);
    assert.ok(SHAPES.includes(s.bot.avatarShape), `${s.slug}: unknown shape ${s.bot.avatarShape}`);
    assert.ok(COLORS.includes(s.bot.avatarColor), `${s.slug}: unknown color ${s.bot.avatarColor}`);
    assert.ok(s.bot.name.length <= 60, `${s.slug}: name over the 60-character limit`);
    for (const r of s.bot.routines) {
      if (r.kind === 'cron') assert.doesNotThrow(() => new Cron(r.schedule, { paused: true }), `${s.slug}: bad cron ${r.schedule}`);
      else assert.match(r.triggerSlug, /^[A-Z0-9_]+$/, `${s.slug}: trigger slug must be a Composio slug`);
    }
  }
  assert.equal(STARTER_TEMPLATES.length, 9);
});

test('bot duplication and templates over HTTP', async (t) => {
  const ada = await signIn('ada@example.test');
  const bea = await signIn('bea@example.test');
  let scoutId = '';
  let templateId = '';

  await t.test('the starter gallery is public and lists all nine starters', async () => {
    const { templates, categories } = await ok(await send('GET', '/api/templates'));
    const starters = templates.filter((x: Json) => x.origin === 'starter');
    assert.equal(starters.length, 9);
    assert.ok(categories.includes('Productivity'));
    const briefing = starters.find((x: Json) => x.slug === 'morning-briefing');
    assert.equal(briefing.cadence, 'Weekdays at 8:00 AM');
    assert.equal(starters.find((x: Json) => x.slug === 'travel-coordinator').cadence, 'On demand');
    assert.equal(briefing.instructions, undefined, 'the listing carries summaries only');
  });

  await t.test('re-seeding converges: no duplicates, install counts survive', async () => {
    const id = templateIdForSlug('bug-reproducer');
    db.prepare('UPDATE bot_templates SET install_count=7 WHERE id=?').run(id);
    seedTemplates(STARTER_TEMPLATES);
    seedTemplates(STARTER_TEMPLATES);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM bot_templates WHERE origin='starter'").get() as Json).n, 9);
    assert.equal((db.prepare('SELECT install_count n FROM bot_templates WHERE id=?').get(id) as Json).n, 7);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM bot_template_skills WHERE template_id=?').get(id) as Json).n, 1);
  });

  await t.test('duplicate copies the setup, pauses routines and leaves history behind', async () => {
    const { bot } = await ok(await send('POST', '/api/bots', { name: 'Scout', label: 'Research', instructions: 'Cite sources.', avatarShape: 'gem', avatarColor: 'violet' }, ada.cookie));
    scoutId = bot.id;
    await ok(await send('POST', '/api/skill-library', { name: 'citations', description: 'Citing sources', content: 'Always link the source.', availability: 'selected', botIds: [scoutId] }, ada.cookie));
    addRoutine(scoutId, { name: 'daily', schedule: '0 9 * * *', timezone: 'America/New_York' });
    addRoutine(scoutId, { name: 'mail', schedule: 'event:GMAIL_NEW_GMAIL_MESSAGE', triggerId: 'trg_live', config: '{"labelIds":"INBOX"}' });
    addRoutine(scoutId, { name: 'once', schedule: '0 9 1 1 *', eventType: 'one_time' });
    await ok(await send('POST', `/api/bots/${scoutId}/messages`, { text: 'hello' }, ada.cookie));
    db.prepare("INSERT INTO memories(id,bot_id,text,created_at) VALUES ('mem_1',?,?,?)").run(scoutId, 'likes tea', Date.now());

    const { bot: copy } = await ok(await send('POST', `/api/bots/${scoutId}/duplicate`, undefined, ada.cookie));
    assert.notEqual(copy.id, scoutId);
    assert.equal(copy.name, 'Copy of Scout');
    assert.equal(copy.isPrimary, false);
    assert.equal(copy.label, 'Research');
    assert.equal(copy.instructions, 'Cite sources.');
    assert.equal(copy.avatarShape, 'gem');
    assert.equal(copy.avatarColor, 'violet');

    const settings = await ok(await send('GET', `/api/bots/${copy.id}/settings`, undefined, ada.cookie));
    assert.deepEqual(settings.skills.map((s: Json) => s.name), ['citations'], 'the copy has the skill its source had');
    assert.match(settings.skills[0].content, /Always link the source\./);
    assert.deepEqual(settings.memories, [], 'memories stay with the source');

    assert.deepEqual(routinesOf(copy.id), [
      { name: 'daily', schedule: '0 9 * * *', timezone: 'America/New_York', enabled: 0, trigger_id: null, trigger_config: null },
      { name: 'mail', schedule: 'event:GMAIL_NEW_GMAIL_MESSAGE', timezone: 'UTC', enabled: 0, trigger_id: null, trigger_config: '{"labelIds":"INBOX"}' },
    ], 'paused, no shared trigger, and the one-time event is not part of the copy');

    const { rows } = await ok(await send('GET', `/api/bots/${copy.id}/rows`, undefined, ada.cookie));
    assert.deepEqual(rows, [], 'no conversation history');
  });

  await t.test('duplicating the primary makes an ordinary Bot', async () => {
    const { bot } = await ok(await send('POST', `/api/bots/${ada.primaryId}/duplicate`, undefined, ada.cookie));
    assert.equal(bot.isPrimary, false);
    const { bots } = await ok(await send('GET', '/api/bots', undefined, ada.cookie));
    assert.equal(bots.filter((b: Json) => b.isPrimary).length, 1);
  });

  await t.test('someone else cannot duplicate or share your Bot', async () => {
    assert.equal((await send('POST', `/api/bots/${scoutId}/duplicate`, undefined, bea.cookie)).status, 404);
    assert.equal((await send('POST', `/api/bots/${scoutId}/template`, {}, bea.cookie)).status, 404);
    assert.equal((await send('POST', `/api/bots/${scoutId}/duplicate`)).status, 401);
  });

  await t.test('share as template returns a link that reads without signing in', async () => {
    const shared = await ok(await send('POST', `/api/bots/${scoutId}/template`, {}, ada.cookie));
    templateId = shared.template.id;
    assert.equal(shared.shareUrl, `http://orbit.test/?template=${templateId}`);
    assert.equal(shared.template.visibility, 'link');

    const { template } = await ok(await send('GET', `/api/templates/${templateId}`));
    assert.equal(template.title, 'Scout');
    assert.equal(template.ownerName, 'ada');
    assert.equal(template.instructions, 'Cite sources.');
    assert.deepEqual(template.routines[0], { kind: 'cron', name: 'daily', prompt: 'do daily', schedule: '0 9 * * *' }, 'the owner\'s zone is not shared');
    assert.deepEqual(template.routines[1], { kind: 'event', name: 'mail', prompt: 'do mail', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', config: { labelIds: 'INBOX' } });

    const { templates } = await ok(await send('GET', '/api/templates'));
    assert.ok(!templates.some((x: Json) => x.id === templateId), 'a link template stays out of the gallery');
  });

  await t.test('sharing again keeps the link and publishes on request', async () => {
    await ok(await send('PATCH', `/api/bots/${scoutId}`, { instructions: 'Cite two sources.' }, ada.cookie));
    const again = await ok(await send('POST', `/api/bots/${scoutId}/template`, { visibility: 'public' }, ada.cookie));
    assert.equal(again.template.id, templateId);
    assert.equal(again.template.instructions, 'Cite two sources.');
    const { templates } = await ok(await send('GET', '/api/templates'));
    assert.ok(templates.some((x: Json) => x.id === templateId));
    assert.equal((await send('POST', `/api/bots/${scoutId}/template`, { visibility: 'everyone' }, ada.cookie)).status, 400);
  });

  await t.test('installing gives the installer a paused copy in their own zone', async () => {
    assert.equal((await send('POST', `/api/templates/${templateId}/install`, {})).status, 401);
    const { bot } = await ok(await send('POST', `/api/templates/${templateId}/install`, { timezone: 'Europe/London' }, bea.cookie));
    assert.equal(bot.name, 'Scout');
    assert.equal(bot.isPrimary, false);
    assert.equal(bot.instructions, 'Cite two sources.');
    const { bots } = await ok(await send('GET', '/api/bots', undefined, bea.cookie));
    assert.ok(bots.some((b: Json) => b.id === bot.id), 'the Bot belongs to the installer');
    assert.deepEqual(routinesOf(bot.id).map((r) => [r.name, r.timezone, r.enabled]), [['daily', 'Europe/London', 0], ['mail', 'UTC', 0]]);
    const { template } = await ok(await send('GET', `/api/templates/${templateId}`));
    assert.equal(template.installCount, 1);
  });

  await t.test('installing a starter by slug sets up its event routine paused', async () => {
    const { bot } = await ok(await send('POST', '/api/templates/inbox-manager/install', { timezone: 'not/a-zone' }, bea.cookie));
    assert.equal(bot.name, 'Inbox Manager');
    assert.deepEqual(routinesOf(bot.id).map((r) => [r.schedule, r.enabled, r.trigger_id]), [['event:GMAIL_NEW_GMAIL_MESSAGE', 0, null]]);
    const settings = await ok(await send('GET', `/api/bots/${bot.id}/settings`, undefined, bea.cookie));
    assert.deepEqual(settings.skills.map((s: Json) => s.name), ['triage-rules'], "a template's skill lands in the installer's library, for that Bot");
  });

  await t.test('only the owner can stop sharing, and the link then stops working', async () => {
    assert.equal((await send('DELETE', `/api/templates/${templateId}`, undefined, bea.cookie)).status, 404);
    assert.equal((await send('DELETE', `/api/templates/${templateIdForSlug('inbox-manager')}`, undefined, ada.cookie)).status, 404, 'starters have no owner');
    await ok(await send('DELETE', `/api/templates/${templateId}`, undefined, ada.cookie));
    assert.equal((await send('GET', `/api/templates/${templateId}`)).status, 404);
  });
});

after(() => {
  cleanupTmpEnv();
});

import { db, now } from './db.js';
import { composio } from './composio.js';
import { appendRow } from './store.js';
import { hub } from './lib/hub.js';
import type { Trigger } from './core/turn-queue.js';
import { blockedApp } from './core/app-access.js';

/**
 * Event routines: Composio triggers (e.g. GMAIL_NEW_GMAIL_MESSAGE, SLACK_RECEIVE_MESSAGE,
 * GITHUB_PULL_REQUEST_EVENT) that wake a bot with a prompt. Stored in the `routines` table
 * with schedule `event:<TRIGGER_SLUG>` so they show up alongside cron routines.
 * Delivery uses Composio's realtime subscription (no public webhook URL needed).
 */

let enqueueFn: ((botId: string, t: Trigger) => void) | null = null;
let subscribed = false;

export const isEventSchedule = (schedule: string) => schedule.startsWith('event:');

/** A JSON object from a third party, or null for anything else. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The two routines columns event routines live in. Idempotent; run by anything that writes one. */
export function ensureTriggerColumns() {
  for (const col of ['trigger_id TEXT', 'trigger_config TEXT']) {
    try { db.exec(`ALTER TABLE routines ADD COLUMN ${col}`); } catch { /* already there */ }
  }
}

export async function initTriggers(enqueue: (botId: string, t: Trigger) => void) {
  ensureTriggerColumns();
  enqueueFn = enqueue;
  const count = (db.prepare("SELECT COUNT(*) n FROM routines WHERE schedule LIKE 'event:%'").get() as { n: number }).n;
  if (count > 0) await ensureSubscribed();
  console.log(`[triggers] ${count} event routine(s)`);
}

async function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  try {
    await composio.triggers.subscribe(
      (data) => onTrigger(data),
      undefined,
      (err) => console.warn('[triggers] subscription error', JSON.stringify(err).slice(0, 300)),
    );
    console.log('[triggers] realtime subscription active');
  } catch (e) {
    subscribed = false;
    console.warn('[triggers] subscribe failed', (e as Error).message);
  }
}

function onTrigger(data: unknown) {
  const d = asRecord(data);
  const md = asRecord(d?.metadata);
  const ids = [d?.id, md?.id, md?.nanoId].filter(Boolean);
  if (!ids.length) return;
  const rows = db.prepare(`SELECT * FROM routines WHERE trigger_id IN (${ids.map(() => '?').join(',')}) AND enabled=1`).all(...ids) as
    { id: string; bot_id: string; name: string; prompt: string; schedule: string }[];
  for (const r of rows) {
    // The event's data must not reach a bot the person has since turned this app off for.
    if (blockedApp(r.bot_id, [r.schedule.slice(6)])) continue;
    const payload = JSON.stringify(d?.payload ?? d?.originalPayload ?? {}, null, 1).slice(0, 8000);
    db.prepare('UPDATE routines SET last_run_at=? WHERE id=?').run(now(), r.id);
    appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-run', text: `Routine triggered: ${r.name}`, ref: r.id });
    enqueueFn?.(r.bot_id, {
      type: 'routine',
      routineId: r.id,
      name: r.name,
      prompt: `${r.prompt}\n\n[Event: ${d?.triggerSlug ?? r.schedule.slice(6)}]\n${payload}`,
    });
  }
}

export async function listTriggerTypes(toolkit: string) {
  const r = (await composio.triggers.listTypes({ toolkits: [toolkit] })) as unknown;
  const listed = asRecord(r)?.items;
  const items: unknown[] = Array.isArray(listed) ? listed : Array.isArray(r) ? r : [];
  return items.slice(0, 40).map((t) => {
    const item = asRecord(t);
    const config = asRecord(item?.config);
    return {
      slug: item?.slug,
      name: item?.name,
      description: String(item?.description ?? '').slice(0, 300),
      config: config?.properties ? { properties: config.properties, required: config.required ?? [] } : item?.config ?? {},
    };
  });
}

/** A new Composio trigger for this user, and its id. Throws when the app is not connected. */
async function createTrigger(userId: string, slug: string, config: Record<string, unknown>): Promise<string> {
  const res = (await composio.triggers.create(userId, slug, { triggerConfig: config } as Parameters<typeof composio.triggers.create>[2])) as
    | { triggerId?: string; trigger_id?: string; id?: string }
    | null
    | undefined;
  const triggerId = res?.triggerId ?? res?.trigger_id ?? res?.id;
  if (!triggerId) throw new Error(`Composio did not return a trigger id: ${JSON.stringify(res).slice(0, 200)}`);
  return triggerId;
}

export async function createEventRoutine(userId: string, botId: string, a: { name: string; prompt: string; trigger_slug: string; config?: Record<string, unknown> }) {
  ensureTriggerColumns();
  const slug = a.trigger_slug.toUpperCase();
  const triggerId = await createTrigger(userId, slug, a.config ?? {});
  const id = `rt_${Math.random().toString(36).slice(2, 12)}`;
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,trigger_id,trigger_config) VALUES (?,?,?,?,?,?,1,?,?,?)')
    .run(id, botId, a.name, a.prompt, `event:${slug}`, 'UTC', now(), triggerId, JSON.stringify(a.config ?? {}));
  await ensureSubscribed();
  return { id, triggerId };
}

/** Called by the routine scheduler when an event routine is enabled/disabled/deleted. */
export async function setEventRoutineEnabled(routineId: string, enabled: boolean) {
  const r = db.prepare('SELECT trigger_id FROM routines WHERE id=?').get(routineId) as { trigger_id: string | null } | undefined;
  if (!r) return;
  if (!r.trigger_id) {
    if (enabled) await armEventRoutine(routineId);
    return;
  }
  try {
    if (enabled) { await composio.triggers.enable(r.trigger_id); await ensureSubscribed(); }
    else await composio.triggers.disable(r.trigger_id);
  } catch (e) {
    console.warn('[triggers] toggle failed', routineId, (e as Error).message);
  }
}

/**
 * Give an event routine with no trigger of its own (a duplicated or template-installed copy) one now.
 * Copies never share their source's trigger: deleting either would silently kill the other. When the
 * app is not connected yet, the routine goes back to paused and its Bot's chat says why.
 */
async function armEventRoutine(routineId: string) {
  const r = db.prepare('SELECT r.bot_id, r.name, r.schedule, r.trigger_config, b.user_id FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=?').get(routineId) as
    | { bot_id: string; name: string; schedule: string; trigger_config: string | null; user_id: string }
    | undefined;
  if (!r || !isEventSchedule(r.schedule)) return;
  try {
    const config = asRecord(JSON.parse(r.trigger_config ?? '{}')) ?? {};
    const triggerId = await createTrigger(r.user_id, r.schedule.slice(6), config);
    db.prepare('UPDATE routines SET trigger_id=? WHERE id=?').run(triggerId, routineId);
    await ensureSubscribed();
  } catch (e) {
    console.warn('[triggers] arm failed', routineId, (e as Error).message);
    db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run(routineId);
    appendRow(r.bot_id, 'event', { type: 'event', event: 'routine-updated', text: `Routine paused: ${r.name} needs its app connected first (${describeEvent(r.schedule)}).`, ref: routineId });
    hub.emit(r.user_id, { type: 'routines', botId: r.bot_id });
  }
}

export function describeEvent(schedule: string) {
  const slug = schedule.slice(6);
  const words = slug.split('_');
  const app = words.shift() ?? '';
  return `When ${app.charAt(0) + app.slice(1).toLowerCase()}: ${words.join(' ').toLowerCase()}`;
}

/** Remove the Composio trigger behind an event routine (call before deleting the routine row). */
export async function deleteEventTrigger(routineId: string) {
  const r = db.prepare('SELECT trigger_id FROM routines WHERE id=?').get(routineId) as { trigger_id: string | null } | undefined;
  if (!r?.trigger_id) return;
  try { await composio.triggers.delete(r.trigger_id); } catch (e) { console.warn('[triggers] delete failed', routineId, (e as Error).message); }
}

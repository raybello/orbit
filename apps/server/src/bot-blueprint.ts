import type { AvatarColor, AvatarShape, Bot, TemplateRoutine, TemplateSkill } from '@orbit/contracts';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { newId } from './lib/ids.js';
import { BotAdminError, createBotFor, ownedBot, updateBotFor } from './bot-admin.js';
import { type RoutineRow } from './store.js';
import { ensureTriggerColumns, isEventSchedule } from './triggers.js';
import type { BotRow } from './infra/bot-repository.js';

/**
 * What makes a Bot itself, minus everything it has lived through.
 *
 * Duplicating a Bot, saving it as a template and installing a template are one operation seen from
 * three sides: read a blueprint off a Bot, or out of a template, then build a fresh Bot from it. A
 * blueprint never carries history, memories, files, the primary flag, an engine or a Composio
 * trigger, so a copy cannot inherit any of them by accident.
 */
export interface BotBlueprint {
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  mode: 'personal' | 'teammate';
  skills: TemplateSkill[];
  routines: TemplateRoutine[];
}

interface SkillRecord { name: string; description: string | null; body: string }
type RoutineRecord = RoutineRow & { trigger_config?: string | null };

/**
 * A routine's portable part. A one-time calendar event is something that happens to a Bot, not part
 * of what it is, so it is left behind.
 */
function routineOf(r: RoutineRecord): TemplateRoutine | null {
  if (r.event_type === 'one_time') return null;
  if (isEventSchedule(r.schedule)) {
    let config: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.trigger_config ?? '{}') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
    } catch { /* a corrupt config travels as none */ }
    return { kind: 'event', name: r.name, prompt: r.prompt, triggerSlug: r.schedule.slice(6), config };
  }
  return { kind: 'cron', name: r.name, prompt: r.prompt, schedule: r.schedule, timezone: r.timezone };
}

export function blueprintOf(bot: BotRow): BotBlueprint {
  ensureTriggerColumns();
  const skills = db.prepare('SELECT name, description, body FROM skills WHERE bot_id=? ORDER BY created_at ASC').all(bot.id) as SkillRecord[];
  const routines = db.prepare('SELECT * FROM routines WHERE bot_id=? ORDER BY created_at ASC').all(bot.id) as RoutineRecord[];
  return {
    name: bot.name,
    label: bot.label,
    description: bot.description,
    instructions: bot.instructions,
    avatarShape: bot.avatar_shape,
    avatarColor: bot.avatar_color,
    mode: bot.mode === 'teammate' ? 'teammate' : 'personal',
    skills: skills.map((s) => ({ name: s.name, description: s.description ?? '', body: s.body })),
    routines: routines.map(routineOf).filter((r): r is TemplateRoutine => r !== null),
  };
}

/** An IANA zone this runtime knows, or null. Callers send whatever the browser reported. */
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return tz.trim();
  } catch {
    return null;
  }
}

/**
 * A new Bot for `userId`, built from a blueprint. Never primary. Every routine lands paused, so a copy
 * cannot double-fire next to its source, and an event routine gets its own trigger only when someone
 * turns it on (triggers.ts armEventRoutine). A cron routine with no zone of its own runs in
 * `timezone`, the installer's.
 */
export function createBotFromBlueprint(userId: string, bp: BotBlueprint, opts: { timezone?: string | null } = {}): Bot {
  const bot = createBotFor(userId, {
    name: bp.name,
    label: bp.label,
    description: bp.description,
    instructions: bp.instructions,
    avatarShape: bp.avatarShape,
    avatarColor: bp.avatarColor,
    mode: bp.mode,
    isPrimary: false,
  });
  ensureTriggerColumns();
  const at = now();
  const addSkill = db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  const addRoutine = db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,trigger_config) VALUES (?,?,?,?,?,?,0,?,?)');
  db.transaction(() => {
    bp.skills.forEach((s, i) => addSkill.run(newId('skl'), bot.id, s.name, s.body, s.description, at + i, at + i));
    bp.routines.forEach((r, i) => {
      if (r.kind === 'event') addRoutine.run(newId('rtn'), bot.id, r.name, r.prompt, `event:${r.triggerSlug}`, 'UTC', at + i, JSON.stringify(r.config));
      else addRoutine.run(newId('rtn'), bot.id, r.name, r.prompt, r.schedule, r.timezone ?? opts.timezone ?? 'UTC', at + i, null);
    });
  })();
  if (bp.routines.length) hub.emit(userId, { type: 'routines', botId: bot.id });
  return bot;
}

/** Room for "Copy of " inside the 60-character name limit. */
const copyName = (name: string) => `Copy of ${name}`.slice(0, 60);

/**
 * Duplicate one of this owner's Bots: same persona, instructions, look, skills, routines (paused),
 * effort and voice. No history, memories, files or primary flag. App connections belong to the
 * account, not the Bot, so the copy reaches the same apps without carrying anything over.
 */
export function duplicateBotFor(userId: string, botId: string): Bot {
  const src = ownedBot(userId, botId);
  if (!src) throw new BotAdminError(404, 'No such bot.');
  if (src.kind === 'room') throw new BotAdminError(400, `"${src.name}" is a group chat, not a Bot.`);
  if (src.hidden) throw new BotAdminError(400, 'A hidden helper Bot cannot be duplicated.');
  const copy = createBotFromBlueprint(userId, { ...blueprintOf(src), name: copyName(src.name) });
  return updateBotFor(userId, copy.id, {
    effort: src.effort,
    voice: src.voice,
    voiceSpeed: src.voice_speed,
    voiceLanguage: src.voice_language,
    voiceProvider: src.voice_provider,
    voiceModel: src.voice_model,
  });
}

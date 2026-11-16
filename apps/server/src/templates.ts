import type { Bot, BotTemplate, BotTemplateSummary, TemplateOrigin, TemplateRoutine, TemplateVisibility } from '@orbit/contracts';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { describeCron } from './store.js';
import { describeEvent } from './triggers.js';
import { BotAdminError, ownedBot } from './bot-admin.js';
import { blueprintOf, createBotFromBlueprint, validTimeZone, type BotBlueprint } from './bot-blueprint.js';
import { STARTER_TEMPLATES } from './seeds/starter-templates.js';

/**
 * Bot templates (F6) and the starter gallery (F7).
 *
 * A template is a stored BotBlueprint plus who shared it and who may see it. Installing one builds a
 * fresh Bot from that blueprint for the installer; nothing of the source Bot's history, memory or
 * connections is ever stored here. Starter templates are the same rows, written from
 * seeds/starter-templates.ts at startup.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS bot_templates (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  origin TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  source_bot_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'link',
  category TEXT NOT NULL DEFAULT '',
  suggested_apps TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_shape TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'personal',
  install_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_templates_source ON bot_templates(owner_user_id, source_bot_id);
CREATE TABLE IF NOT EXISTS bot_template_skills (
  template_id TEXT NOT NULL REFERENCES bot_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  skill_description TEXT NOT NULL DEFAULT '',
  skill_body TEXT NOT NULL,
  PRIMARY KEY (template_id, position)
);
CREATE TABLE IF NOT EXISTS bot_template_routines (
  template_id TEXT NOT NULL REFERENCES bot_templates(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  routine_data TEXT NOT NULL,
  PRIMARY KEY (template_id, position)
);
`);

/**
 * One entry of a seed registry. `slug` is the stable key: the row id is derived from it, so seeding
 * is an upsert, and a team seed (F11) can name its member Bots by slug. A member that should not
 * stand alone in the gallery uses visibility 'link'.
 */
export interface BotTemplateSeed {
  slug: string;
  category: string;
  suggestedApps: string[];
  /** Defaults to 'public'. */
  visibility?: TemplateVisibility;
  bot: BotBlueprint;
}

interface TemplateRecord {
  id: string;
  slug: string | null;
  origin: TemplateOrigin;
  ownerUserId: string | null;
  sourceBotId: string | null;
  visibility: TemplateVisibility;
  category: string;
  suggestedApps: string[];
  bot: BotBlueprint;
}

interface TemplateRow {
  id: string;
  slug: string | null;
  origin: string;
  owner_user_id: string | null;
  source_bot_id: string | null;
  visibility: string;
  category: string;
  suggested_apps: string;
  title: string;
  label: string;
  description: string;
  instructions: string;
  avatar_shape: BotTemplate['avatarShape'];
  avatar_color: BotTemplate['avatarColor'];
  mode: string;
  install_count: number;
  created_at: number;
  updated_at: number;
  owner_name: string | null;
}

export const templateIdForSlug = (slug: string) => `tpl_${slug}`;
export const shareUrlFor = (templateId: string) => `${env.appUrl}/?template=${encodeURIComponent(templateId)}`;

/** Upsert the row and replace its skills and routines. Install counts and creation time survive. */
function writeTemplate(t: TemplateRecord): void {
  const at = now();
  db.prepare(
    `INSERT INTO bot_templates(id,slug,origin,owner_user_id,source_bot_id,visibility,category,suggested_apps,title,label,description,instructions,avatar_shape,avatar_color,mode,created_at,updated_at)
     VALUES (@id,@slug,@origin,@owner,@source,@visibility,@category,@apps,@title,@label,@description,@instructions,@shape,@color,@mode,@at,@at)
     ON CONFLICT(id) DO UPDATE SET slug=@slug, origin=@origin, owner_user_id=@owner, source_bot_id=@source, visibility=@visibility,
       category=@category, suggested_apps=@apps, title=@title, label=@label, description=@description, instructions=@instructions,
       avatar_shape=@shape, avatar_color=@color, mode=@mode, updated_at=@at`,
  ).run({
    id: t.id, slug: t.slug, origin: t.origin, owner: t.ownerUserId, source: t.sourceBotId, visibility: t.visibility,
    category: t.category, apps: JSON.stringify(t.suggestedApps), title: t.bot.name, label: t.bot.label,
    description: t.bot.description, instructions: t.bot.instructions, shape: t.bot.avatarShape, color: t.bot.avatarColor,
    mode: t.bot.mode, at,
  });
  db.prepare('DELETE FROM bot_template_skills WHERE template_id=?').run(t.id);
  db.prepare('DELETE FROM bot_template_routines WHERE template_id=?').run(t.id);
  const addSkill = db.prepare('INSERT INTO bot_template_skills(template_id,position,skill_name,skill_description,skill_body) VALUES (?,?,?,?,?)');
  const addRoutine = db.prepare('INSERT INTO bot_template_routines(template_id,position,routine_data) VALUES (?,?,?)');
  t.bot.skills.forEach((s, i) => addSkill.run(t.id, i, s.name, s.description, s.body));
  t.bot.routines.forEach((r, i) => addRoutine.run(t.id, i, JSON.stringify(r)));
}

/** Write a seed registry. Idempotent: run it at every startup and the rows match the registry. */
export function seedTemplates(seeds: readonly BotTemplateSeed[]): void {
  db.transaction(() => {
    for (const s of seeds) {
      writeTemplate({
        id: templateIdForSlug(s.slug), slug: s.slug, origin: 'starter', ownerUserId: null, sourceBotId: null,
        visibility: s.visibility ?? 'public', category: s.category, suggestedApps: s.suggestedApps, bot: s.bot,
      });
    }
  })();
}

const SELECT_TEMPLATE = 'SELECT t.*, u.name AS owner_name FROM bot_templates t LEFT JOIN users u ON u.id=t.owner_user_id';

function routinesOf(templateId: string): TemplateRoutine[] {
  return (db.prepare('SELECT routine_data FROM bot_template_routines WHERE template_id=? ORDER BY position').all(templateId) as { routine_data: string }[])
    .map((r) => JSON.parse(r.routine_data) as TemplateRoutine);
}

function cadenceOf(routines: TemplateRoutine[]): string {
  if (!routines.length) return 'On demand';
  return routines.map((r) => (r.kind === 'cron' ? describeCron(r.schedule) : describeEvent(`event:${r.triggerSlug}`))).join(' · ');
}

function toSummary(r: TemplateRow, routines: TemplateRoutine[]): BotTemplateSummary {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    label: r.label,
    description: r.description,
    category: r.category,
    avatarShape: r.avatar_shape,
    avatarColor: r.avatar_color,
    visibility: r.visibility === 'public' ? 'public' : 'link',
    origin: r.origin === 'starter' ? 'starter' : 'user',
    suggestedApps: JSON.parse(r.suggested_apps) as string[],
    cadence: cadenceOf(routines),
    installCount: r.install_count,
    ownerName: r.owner_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** One template by id or slug, whatever its visibility: holding the id is what a link shares. */
export function getTemplate(idOrSlug: string): BotTemplate | null {
  const r = db.prepare(`${SELECT_TEMPLATE} WHERE t.id=? OR t.slug=?`).get(idOrSlug, idOrSlug) as TemplateRow | undefined;
  if (!r) return null;
  const routines = routinesOf(r.id);
  const skills = (db.prepare('SELECT skill_name, skill_description, skill_body FROM bot_template_skills WHERE template_id=? ORDER BY position').all(r.id) as
    { skill_name: string; skill_description: string; skill_body: string }[])
    .map((s) => ({ name: s.skill_name, description: s.skill_description, body: s.skill_body }));
  return {
    ...toSummary(r, routines),
    instructions: r.instructions,
    mode: r.mode === 'teammate' ? 'teammate' : 'personal',
    skills,
    routines,
  };
}

/** The public gallery: starters first, then the most installed. */
export function listPublicTemplates(): BotTemplateSummary[] {
  const rows = db.prepare(`${SELECT_TEMPLATE} WHERE t.visibility='public' ORDER BY (t.origin='starter') DESC, t.install_count DESC, t.title ASC`).all() as TemplateRow[];
  return rows.map((r) => toSummary(r, routinesOf(r.id)));
}

/**
 * Save one of this owner's Bots as a template and return it. Sharing the same Bot again refreshes the
 * snapshot under the same id, so a link already handed out keeps working and shows the latest setup.
 * Cron routines lose their zone: whoever installs one runs it in their own.
 */
export function shareBotAsTemplate(userId: string, botId: string, opts: { visibility?: TemplateVisibility } = {}): BotTemplate {
  const bot = ownedBot(userId, botId);
  if (!bot) throw new BotAdminError(404, 'No such bot.');
  if (bot.kind === 'room') throw new BotAdminError(400, `"${bot.name}" is a group chat, not a Bot.`);
  if (bot.hidden) throw new BotAdminError(400, 'A hidden helper Bot cannot be shared.');
  const existing = db.prepare('SELECT id, visibility FROM bot_templates WHERE owner_user_id=? AND source_bot_id=?').get(userId, botId) as
    | { id: string; visibility: TemplateVisibility }
    | undefined;
  const bp = blueprintOf(bot);
  const id = existing?.id ?? newId('tpl');
  db.transaction(() => writeTemplate({
    id, slug: null, origin: 'user', ownerUserId: userId, sourceBotId: botId,
    visibility: opts.visibility ?? existing?.visibility ?? 'link', category: '', suggestedApps: [],
    bot: { ...bp, routines: bp.routines.map((r) => (r.kind === 'cron' ? { kind: 'cron', name: r.name, prompt: r.prompt, schedule: r.schedule } : r)) },
  }))();
  return getTemplate(id)!;
}

/** Stop sharing: the link stops working. Bots already installed from it are untouched. */
export function deleteTemplateFor(userId: string, templateId: string): void {
  const r = db.prepare('DELETE FROM bot_templates WHERE id=? AND owner_user_id=?').run(templateId, userId);
  if (!r.changes) throw new BotAdminError(404, 'No such template.');
}

/**
 * Install a template for `userId`: a new Bot built from it, never primary, routines paused. `name`
 * overrides the template's title (a team wizard names its members); `timezone` is where cron
 * routines without their own zone run.
 */
export function installTemplate(templateId: string, userId: string, opts: { name?: string; timezone?: string } = {}): Bot {
  const t = getTemplate(templateId);
  if (!t) throw new BotAdminError(404, 'No such template.');
  const bot = createBotFromBlueprint(userId, {
    name: opts.name?.trim() || t.title,
    label: t.label,
    description: t.description,
    instructions: t.instructions,
    avatarShape: t.avatarShape,
    avatarColor: t.avatarColor,
    mode: t.mode,
    skills: t.skills,
    routines: t.routines,
  }, { timezone: validTimeZone(opts.timezone) });
  db.prepare('UPDATE bot_templates SET install_count = install_count + 1 WHERE id=?').run(t.id);
  return bot;
}

seedTemplates(STARTER_TEMPLATES);

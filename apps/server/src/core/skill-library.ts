import type { LibrarySkill, SkillAuthor, SkillSource } from '@orbit/contracts';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { MAX_DESCRIPTION, MAX_SKILL_MD, expandSkillCommands, nameProblem, parseSkillMd, skillBody, skillMdFor, slugifySkillName } from '../domain/skill-md.js';

/**
 * The shared skill library: one per person, every skill available to every one of their Bots unless
 * it is turned off for that Bot. A skill with availability 'selected' is the other way round: only
 * the Bots allowed in `skill_access` have it, so a new Bot does not get it.
 */

interface SkillRow {
  id: string; user_id: string; name: string; description: string; content: string;
  availability: 'all' | 'selected'; source: string;
  created_by_kind: 'user' | 'bot'; created_by_id: string; created_by_name: string;
  created_at: number; updated_at: number;
}

/** A skill the library refuses, with the reason the person (or the Bot) is shown. */
export class SkillError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

/** Supporting files a skill may carry, at most. GitHub installs are held to the same limits. */
export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

// SELECT * and filter in JS: `kind` and `hidden` are added to the bots table lazily (initRooms, initSubagents).
const agentsOf = (userId: string) =>
  (db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY is_primary DESC, created_at').all(userId) as { id: string; name: string; kind?: string | null; hidden?: number | null }[])
    .filter((b) => b.kind !== 'room' && !b.hidden)
    .map((b) => ({ id: b.id, name: b.name }));

const accessRows = (skillId: string) =>
  new Map((db.prepare('SELECT bot_id, allowed FROM skill_access WHERE skill_id=?').all(skillId) as { bot_id: string; allowed: number }[]).map((r) => [r.bot_id, !!r.allowed]));

const allowedFor = (row: Pick<SkillRow, 'availability'>, access: Map<string, boolean>, botId: string) =>
  access.get(botId) ?? row.availability === 'all';

function toSkill(r: SkillRow, bots = agentsOf(r.user_id)): LibrarySkill {
  const access = accessRows(r.id);
  const files = db.prepare('SELECT path, length(content) AS size FROM skill_files WHERE skill_id=? ORDER BY path').all(r.id) as { path: string; size: number }[];
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    content: r.content,
    availability: r.availability,
    source: JSON.parse(r.source) as SkillSource,
    createdBy: { kind: r.created_by_kind, id: r.created_by_id, name: r.created_by_name },
    files,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    bots: bots.map((b) => ({ botId: b.id, botName: b.name, allowed: allowedFor(r, access, b.id) })),
  };
}

const rowOf = (userId: string, id: string) => db.prepare('SELECT * FROM skill_library WHERE id=? AND user_id=?').get(id, userId) as SkillRow | undefined;
const rowByName = (userId: string, name: string) => db.prepare('SELECT * FROM skill_library WHERE user_id=? AND name=?').get(userId, name) as SkillRow | undefined;

export function listLibrary(userId: string): LibrarySkill[] {
  const bots = agentsOf(userId);
  return (db.prepare('SELECT * FROM skill_library WHERE user_id=? ORDER BY name').all(userId) as SkillRow[]).map((r) => toSkill(r, bots));
}

export function getLibrarySkill(userId: string, id: string): LibrarySkill {
  const r = rowOf(userId, id);
  if (!r) throw new SkillError('not found', 404);
  return toSkill(r);
}

export interface NewSkill {
  name: string;
  content: string;
  description?: string;
  availability?: 'all' | 'selected';
  /** With availability 'selected': the Bots that have it. */
  botIds?: string[];
  source?: SkillSource;
  files?: { path: string; content: Buffer }[];
}

/**
 * The name, description and SKILL.md a skill is stored with. The description is the one given, or
 * the frontmatter's; the stored file's frontmatter always carries the library's name and description.
 */
function normalize(name: string, content: string, description?: string): { name: string; description: string; content: string } {
  const problem = nameProblem(name);
  if (problem) throw new SkillError(problem);
  if (content.length > MAX_SKILL_MD) throw new SkillError(`A SKILL.md is at most ${MAX_SKILL_MD / 1000}k characters`);
  const parsed = parseSkillMd(content);
  if ('error' in parsed) throw new SkillError(parsed.error);
  if (!parsed.body) throw new SkillError('Write the instructions for this skill');
  const desc = (description ?? '').trim() || String(parsed.frontmatter.description ?? '').trim();
  if (!desc) throw new SkillError('Say what the skill is for: a description, or `description:` in its frontmatter');
  if (desc.length > MAX_DESCRIPTION) throw new SkillError(`A description is at most ${MAX_DESCRIPTION} characters`);
  return { name, description: desc, content: skillMdFor(name, desc, content) };
}

function checkFiles(files: { path: string; content: Buffer }[]) {
  if (files.length > MAX_FILES) throw new SkillError(`A skill carries at most ${MAX_FILES} files`);
  let total = 0;
  for (const f of files) {
    if (!f.path || f.path.startsWith('/') || f.path.split('/').some((p) => !p || p === '.' || p === '..')) throw new SkillError(`Not a file path inside the skill: ${f.path}`);
    if (f.content.length > MAX_FILE_BYTES) throw new SkillError(`${f.path} is larger than ${MAX_FILE_BYTES / 1024} KB`);
    total += f.content.length;
  }
  if (total > MAX_TOTAL_BYTES) throw new SkillError(`A skill's files total at most ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);
}

/** Add a skill to this person's library. A name already in use is refused (409). */
export function createSkill(userId: string, author: SkillAuthor, s: NewSkill): LibrarySkill {
  const { name, description, content } = normalize(s.name, s.content, s.description);
  if (rowByName(userId, name)) throw new SkillError(`There is already a skill named ${name}`, 409);
  const files = s.files ?? [];
  checkFiles(files);
  const availability = s.availability ?? 'all';
  const mine = new Set(agentsOf(userId).map((b) => b.id));
  const id = newId('skl');
  const at = now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO skill_library(id,user_id,name,description,content,availability,source,created_by_kind,created_by_id,created_by_name,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, userId, name, description, content, availability, JSON.stringify(s.source ?? { type: 'manual' }), author.kind, author.id, author.name, at, at);
    const addFile = db.prepare('INSERT INTO skill_files(skill_id,path,content) VALUES (?,?,?)');
    for (const f of files) addFile.run(id, f.path, f.content);
    if (availability === 'selected') {
      const grant = db.prepare('INSERT INTO skill_access(skill_id,bot_id,allowed) VALUES (?,?,1)');
      for (const b of new Set(s.botIds ?? [])) if (mine.has(b)) grant.run(id, b);
    }
  })();
  return getLibrarySkill(userId, id);
}

/** Change a skill's name, SKILL.md, description or availability. Where it came from never changes. */
export function updateSkill(userId: string, id: string, p: { name?: string; content?: string; description?: string; availability?: 'all' | 'selected' }): LibrarySkill {
  const cur = rowOf(userId, id);
  if (!cur) throw new SkillError('not found', 404);
  const nameChanged = p.name !== undefined && p.name !== cur.name;
  // A new SKILL.md brings its own description unless one is given with it.
  const description = p.description ?? (p.content !== undefined ? undefined : cur.description);
  const next = normalize(p.name ?? cur.name, p.content ?? cur.content, description);
  if (nameChanged && rowByName(userId, next.name)) throw new SkillError(`There is already a skill named ${next.name}`, 409);
  db.transaction(() => {
    db.prepare('UPDATE skill_library SET name=?, description=?, content=?, updated_at=? WHERE id=?').run(next.name, next.description, next.content, now(), id);
    if (p.availability && p.availability !== cur.availability) setAvailability(cur, p.availability);
  })();
  return getLibrarySkill(userId, id);
}

/**
 * Switch between "every Bot" and "only the selected Bots" without changing who has it today: going
 * to 'selected' writes the current Bots as allowed; going to 'all' keeps only the explicit refusals.
 */
function setAvailability(cur: SkillRow, to: 'all' | 'selected') {
  const access = accessRows(cur.id);
  if (to === 'selected') {
    const set = db.prepare('INSERT OR REPLACE INTO skill_access(skill_id,bot_id,allowed) VALUES (?,?,?)');
    for (const b of agentsOf(cur.user_id)) set.run(cur.id, b.id, allowedFor(cur, access, b.id) ? 1 : 0);
  } else {
    db.prepare('DELETE FROM skill_access WHERE skill_id=? AND allowed=1').run(cur.id);
  }
  db.prepare('UPDATE skill_library SET availability=? WHERE id=?').run(to, cur.id);
}

export function deleteSkill(userId: string, id: string): void {
  if (!rowOf(userId, id)) throw new SkillError('not found', 404);
  db.prepare('DELETE FROM skill_library WHERE id=?').run(id);
}

/** Allow or stop one Bot using one skill. */
export function setSkillAccess(userId: string, id: string, botId: string, allowed: boolean): LibrarySkill {
  const cur = rowOf(userId, id);
  if (!cur) throw new SkillError('not found', 404);
  if (!agentsOf(userId).some((b) => b.id === botId)) throw new SkillError('not found', 404);
  const byDefault = cur.availability === 'all';
  if (allowed === byDefault) db.prepare('DELETE FROM skill_access WHERE skill_id=? AND bot_id=?').run(id, botId);
  else db.prepare('INSERT OR REPLACE INTO skill_access(skill_id,bot_id,allowed) VALUES (?,?,?)').run(id, botId, allowed ? 1 : 0);
  return toSkill(cur);
}

/**
 * Make sure this Bot has a skill a template or a copied Bot brings: the library's skill of that name
 * if there is one (turned on for this Bot), otherwise a new skill only this Bot has.
 */
export function giveSkillTo(userId: string, botId: string, s: { name: string; description: string; body: string }): void {
  const name = slugifySkillName(s.name);
  const have = rowByName(userId, name);
  if (have) { setSkillAccess(userId, have.id, botId, true); return; }
  const owner = db.prepare('SELECT name FROM users WHERE id=?').get(userId) as { name: string } | undefined;
  createSkill(userId, { kind: 'user', id: userId, name: owner?.name || 'You' }, {
    name, content: s.body, description: s.description.trim() || s.name, availability: 'selected', botIds: [botId],
  });
}

/** The skills this Bot may use, by name. */
export function skillsForBot(botId: string): SkillRow[] {
  const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as { user_id: string } | undefined;
  if (!bot) return [];
  return db.prepare(
    `SELECT s.* FROM skill_library s LEFT JOIN skill_access a ON a.skill_id=s.id AND a.bot_id=?
     WHERE s.user_id=? AND COALESCE(a.allowed, s.availability='all') ORDER BY s.name`,
  ).all(botId, bot.user_id) as SkillRow[];
}

/** One skill this Bot may use, by name, with its supporting files' paths. */
export function botSkill(botId: string, name: string): (SkillRow & { files: string[] }) | null {
  const s = skillsForBot(botId).find((r) => r.name === name);
  if (!s) return null;
  const files = (db.prepare('SELECT path FROM skill_files WHERE skill_id=? ORDER BY path').all(s.id) as { path: string }[]).map((f) => f.path);
  return { ...s, files };
}

export function botSkillFile(skillId: string, path: string): Buffer | null {
  return (db.prepare('SELECT content FROM skill_files WHERE skill_id=? AND path=?').get(skillId, path) as { content: Buffer } | undefined)?.content ?? null;
}

/** A turn's input with every `/<name>` of a skill this Bot has replaced by that skill's instructions. */
export function expandForBot(botId: string, text: string): { text: string; used: string[] } {
  const skills = skillsForBot(botId);
  if (!skills.length) return { text, used: [] };
  return expandSkillCommands(text, new Map(skills.map((s) => [s.name, skillBody(s.content)])));
}

import { db } from './db.js';
import { skillMdFor, slugifySkillName } from './domain/skill-md.js';

/**
 * Schema additions for bot settings, memory over time and hibernation.
 * Kept out of db.ts on purpose: everything here is idempotent (CREATE IF NOT EXISTS
 * and ALTERs guarded by a column check), so it is safe on old and new databases.
 */

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
}

function addColumn(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

/**
 * Skills used to belong to one bot (`skills`). Each one moves into the shared library as a skill
 * only that bot has, under a library-safe name, and the old table goes. Runs once: afterwards
 * there is no `skills` table to read.
 */
export function migrateBotSkills() {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skills'").get()) return;
  const rows = db.prepare(
    `SELECT s.*, b.user_id, b.name AS bot_name FROM skills s JOIN bots b ON b.id=s.bot_id ORDER BY s.created_at`,
  ).all() as { id: string; bot_id: string; name: string; body: string; description?: string; created_at: number; updated_at?: number | null; user_id: string; bot_name: string }[];
  const taken = db.prepare('SELECT 1 FROM skill_library WHERE user_id=? AND name=?');
  const insert = db.prepare(
    `INSERT INTO skill_library(id,user_id,name,description,content,availability,source,created_by_kind,created_by_id,created_by_name,created_at,updated_at)
     VALUES (?,?,?,?,?,'selected','{"type":"manual"}','user',?,?,?,?)`,
  );
  const owner = db.prepare('SELECT name FROM users WHERE id=?');
  const grant = db.prepare('INSERT INTO skill_access(skill_id,bot_id,allowed) VALUES (?,?,1)');
  db.transaction(() => {
    for (const r of rows) {
      const base = slugifySkillName(r.name);
      let name = base;
      for (let n = 2; taken.get(r.user_id, name); n++) name = `${base.slice(0, 60)}-${n}`;
      const description = (r.description ?? '').trim() || r.name;
      const who = (owner.get(r.user_id) as { name: string } | undefined)?.name ?? 'You';
      insert.run(r.id, r.user_id, name, description, skillMdFor(name, description, r.body), r.user_id, who, r.created_at, r.updated_at ?? r.created_at);
      grant.run(r.id, r.bot_id);
    }
    db.exec('DROP TABLE skills');
  })();
  if (rows.length) console.log(`[skills] moved ${rows.length} bot skill(s) into the shared library`);
}

migrateBotSkills();
/** 'chat' = saved by the bot's remember tool, 'learned' = extracted by consolidation. */
addColumn('memories', 'source', "TEXT NOT NULL DEFAULT 'chat'");

db.exec(`
CREATE TABLE IF NOT EXISTS memory_jobs (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  last_consolidated_at INTEGER NOT NULL DEFAULT 0,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  method TEXT NOT NULL,
  items_before INTEGER NOT NULL,
  items_after INTEGER NOT NULL,
  chars_before INTEGER NOT NULL,
  chars_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- One computer per bot: its own container. The 'computers' and 'screens' tables are left over from
-- the shared Orgo computer and are no longer read.
CREATE TABLE IF NOT EXISTS bot_computers (
  bot_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'docker',
  state        TEXT NOT NULL DEFAULT 'stopped',
  container_id TEXT,
  home_path    TEXT,
  error        TEXT,
  updated_at   INTEGER NOT NULL
);
-- A bot's screen: which X display it owns on its computer and the ports and tokens behind it.
CREATE TABLE IF NOT EXISTS computer_screens (
  bot_id        TEXT NOT NULL,
  screen_id     TEXT NOT NULL,
  display_index INTEGER NOT NULL,
  vnc_port      INTEGER,
  cdp_port      INTEGER,
  view_token    TEXT,
  control_token TEXT,
  idle_at       INTEGER,
  ensured_at    INTEGER,
  PRIMARY KEY (bot_id, screen_id)
);
CREATE INDEX IF NOT EXISTS computer_screens_display ON computer_screens(display_index);
-- One screen per container: a bot's screen row is unique per bot, so it can be replaced in place.
CREATE UNIQUE INDEX IF NOT EXISTS computer_screens_bot ON computer_screens(bot_id);
`);

/** A bot that lived on the shared Orgo computer gets a container like every other bot. Idempotent. */
export function migrateSharedComputerBots(): void {
  db.exec("UPDATE bot_computers SET kind='docker' WHERE kind<>'docker'");
}
migrateSharedComputerBots();

export const configSchemaReady = true;

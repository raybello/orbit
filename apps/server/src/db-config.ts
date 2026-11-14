import { db } from './db.js';

/**
 * Schema additions for bot settings, memory over time and hibernation.
 * Kept out of db.ts on purpose: everything here is idempotent (CREATE IF NOT EXISTS
 * and ALTERs guarded by a column check), so it is safe on old and new databases.
 */

function hasColumn(table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === col);
}

function addColumn(table: string, col: string, ddl: string) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

addColumn('skills', 'description', "TEXT NOT NULL DEFAULT ''");
addColumn('skills', 'updated_at', 'INTEGER');
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
-- One computer per bot. The 'computers' table above is the legacy per-user shared computer; this one
-- records where each bot's own desktop lives ('orgo' = the shared computer, 'docker' = a container).
CREATE TABLE IF NOT EXISTS bot_computers (
  bot_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'orgo',
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

export const configSchemaReady = true;

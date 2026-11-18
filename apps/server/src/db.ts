import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { migrateUnsetVoiceProviders } from './infra/voice-provider-migration.js';

fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  provisional_user_id TEXT NOT NULL,
  connected_account_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  orgo_id TEXT,
  status TEXT NOT NULL DEFAULT 'absent',
  error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  avatar_shape TEXT NOT NULL DEFAULT 'blob',
  avatar_color TEXT NOT NULL DEFAULT 'blue',
  mode TEXT NOT NULL DEFAULT 'personal',
  is_primary INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  effort TEXT NOT NULL DEFAULT 'medium',
  generation INTEGER NOT NULL DEFAULT 1,
  next_seq INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rows (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, generation, seq)
);
CREATE INDEX IF NOT EXISTS rows_rev ON rows(bot_id, updated_seq);
CREATE TABLE IF NOT EXISTS llm_items (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (bot_id, generation, idx)
);
CREATE TABLE IF NOT EXISTS pending_turns (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  row_seq INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS policies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (user_id, tool)
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'working',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS composio_sessions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL
);
-- Expo push tokens for the mobile client. A token is unique: re-registering it moves it to the
-- user who holds the phone now.
CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_tokens_user ON push_tokens(user_id);
`);

// Idempotent column migrations for tables that predate a column.
function addColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
addColumn('bots', 'voice', "TEXT NOT NULL DEFAULT 'luna'");
addColumn('bots', 'voice_speed', 'REAL NOT NULL DEFAULT 1');
addColumn('bots', 'voice_language', "TEXT NOT NULL DEFAULT 'auto'");
// Local (on-device) voice: which pipeline a bot should use, and which on-device voice model.
// 'cloud' keeps today's xAI realtime path; 'local' uses sherpa-onnx unless the models are missing,
// in which case the client falls back on its own (the server never silently proxies to xAI).
addColumn('bots', 'voice_provider', "TEXT NOT NULL DEFAULT 'cloud'");
addColumn('bots', 'voice_model', "TEXT NOT NULL DEFAULT 'piper-lessac-medium'");
// GPU voice (audio.cpp, voice_provider='audiocpp'): the LFM3-Audio voice, and the optional lip-synced
// portrait (a 512x512 JPEG on the data volume; see voice-audiocpp-endpoints.ts).
addColumn('bots', 'audiocpp_voice', "TEXT NOT NULL DEFAULT 'american_english_female'");
addColumn('bots', 'avatar_enabled', 'INTEGER NOT NULL DEFAULT 0');
// Per-bot "Always allow": off for every bot until the person turns it on. While on, the bot's
// approval cards offer "Always allow for <Bot>" and what the person allows is kept in bot_policies,
// for that bot only. Turning it off keeps the list but stops using it.
addColumn('bots', 'always_allow', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS bot_policies (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, tool)
)`);
addColumn('bots', 'avatar_portrait_path', 'TEXT');
migrateUnsetVoiceProviders(db);
// Hermes engine: per-bot model choice, which engine runs the bot ('primary' = the existing agent,
// 'managed' = a gateway we start), and the managed gateway's port.
addColumn('bots', 'model', 'TEXT');
addColumn('bots', 'provider', 'TEXT');
addColumn('bots', 'engine', 'TEXT');
addColumn('bots', 'engine_port', 'INTEGER');
addColumn('bots', 'handback_at', 'INTEGER');
addColumn('screens', 'width', 'INTEGER');
addColumn('screens', 'height', 'INTEGER');
// Calendar metadata for routines. A routine without these stays a plain recurring cron routine.
addColumn('routines', 'calendar_title', 'TEXT');
addColumn('routines', 'event_type', "TEXT NOT NULL DEFAULT 'recurring'");
addColumn('routines', 'event_date', 'TEXT');
addColumn('routines', 'assigned_bot_id', 'TEXT');
addColumn('routines', 'completed_at', 'TEXT');

// ---- Proactive initiative (F8) ----
// `proactivity` used to be created by initProactive, which only runs with the scheduler; created here,
// every process that opens the database can read check-in settings.
// `initiative_signals` is an outbox keyed by occurrence, so a signal is delivered at most once across
// restarts. `morning_briefings` records the briefing seeded for each person: a row whose routine_id
// went NULL means they deleted it, and it is not seeded again.
db.exec(`
CREATE TABLE IF NOT EXISTS proactivity (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  times TEXT NOT NULL DEFAULT '["09:00","16:30"]',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  last_fired TEXT,
  silent_streak INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS initiative_signals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'suppressed')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS morning_briefings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
`);
addColumn('proactivity', 'idle_hours', 'INTEGER NOT NULL DEFAULT 24');
addColumn('bots', 'initiative', "TEXT NOT NULL DEFAULT 'proactive'");
// 'running' | 'ok' | 'failed' | 'stopped' for the run that started at last_run_at.
addColumn('routines', 'last_run_status', 'TEXT');
// ---- end F8 ----

export const now = () => Date.now();

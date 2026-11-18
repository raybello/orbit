import type { AvatarColor, AvatarShape, InitiativeLevel, VoiceProvider } from '@orbit/contracts';
import { db } from '../db.js';

/**
 * The `bots` table, as types and three statements.
 *
 * BotRow lists every column the table ends up with: the CREATE TABLE in db.ts plus the columns added
 * later by db.ts's addColumn calls and by initSubagents()/initRooms(). SQLite has no per-row schema,
 * so a row read before those migrations ran would lack the later fields; the optional ones are typed
 * nullable and the readers treat a missing value as null.
 *
 * No rules live here: nothing validates, defaults or normalises. Callers hand in values they have
 * already decided on (core/bot-service.ts), and get back exactly what the row says.
 */

export interface BotRow {
  id: string;
  user_id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatar_shape: AvatarShape;
  avatar_color: AvatarColor;
  mode: 'personal' | 'teammate';
  /** 0/1 in SQLite. */
  is_primary: number;
  pinned: number;
  effort: string;
  generation: number;
  next_seq: number;
  rev: number;
  unread: number;
  created_at: number;
  updated_at: number;
  /** Voice call settings (db.ts addColumn). */
  voice: string;
  voice_speed: number;
  voice_language: string;
  voice_provider: string;
  voice_model: string;
  /** audio.cpp GPU voice (db.ts addColumn). */
  audiocpp_voice: string | null;
  avatar_enabled: number | null;
  /** Per-bot "Always allow" (db.ts addColumn). */
  always_allow: number | null;
  avatar_portrait_path: string | null;
  /** Hermes engine (db.ts addColumn). */
  model: string | null;
  provider: string | null;
  engine: string | null;
  engine_port: number | null;
  handback_at: number | null;
  /** Proactive initiative (db.ts addColumn); written only through the validated PATCH. */
  initiative: InitiativeLevel;
  /** Added by initRooms(): 'agent' | 'room'. */
  kind: string | null;
  /** Added by initSubagents(): a hidden child bot's parent, and the hidden flag. */
  parent_bot_id: string | null;
  hidden: number | null;
  /** Added by initRooms(): JSON array of member bot ids, on a room. */
  members: string | null;
  /** Added by initRooms(): 1 when this room was created by a team template. */
  is_team: number | null;
}

/** The values a new bot row is made of. Timestamps are passed in so a caller controls the clock. */
export interface NewBotValues {
  id: string;
  userId: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  mode: 'personal' | 'teammate';
  isPrimary: boolean;
  voiceProvider: VoiceProvider;
  voiceModel: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Insert one bot. Columns and order are exactly the INSERT routes.ts used to run inline, so the
 * defaults the schema fills in (generation, next_seq, rev, unread, effort, pinned, ...) are the same.
 */
export function insertBot(v: NewBotValues): void {
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,voice_provider,voice_model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    v.id, v.userId, v.name, v.label, v.description, v.instructions, v.avatarShape, v.avatarColor,
    v.mode, v.isPrimary ? 1 : 0, v.voiceProvider, v.voiceModel,
    v.createdAt, v.updatedAt,
  );
}

/** One bot by id, or undefined. Ownership is the caller's check, not this one's. */
export function botRow(id: string): BotRow | undefined {
  return db.prepare('SELECT * FROM bots WHERE id=?').get(id) as BotRow | undefined;
}

/** Every bot of one user, oldest first. Rooms and hidden subagents are included: filtering is a rule. */
export function botRowsForUser(userId: string): BotRow[] {
  return db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY created_at ASC').all(userId) as BotRow[];
}

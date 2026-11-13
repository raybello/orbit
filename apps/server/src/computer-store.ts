import { db, now } from './db.js';

/**
 * Where each bot's computer lives and what its screen is called. Two small tables:
 *
 *  - bot_computers: one row per bot — provider kind ('orgo' | 'docker'), lifecycle state, and the
 *    Docker container and host home folder behind it when it is a container.
 *  - computer_screens: one row per bot screen — its X display index on that computer, the ports the
 *    host reaches it on, and the VNC view token plus the human-control token.
 *
 * Display indexes are allocated globally (one per running screen) so every bot's VNC and CDP ports
 * are unique on the host; that is what lets vnc.ts and the DevTools clients use 127.0.0.1:port.
 */

export type ComputerKind = 'orgo' | 'docker';
export type ComputerRuntimeState = 'stopped' | 'booting' | 'running' | 'suspending' | 'suspended' | 'error';

export interface BotComputerRow {
  bot_id: string;
  kind: ComputerKind;
  state: ComputerRuntimeState;
  container_id: string | null;
  home_path: string | null;
  error: string | null;
  updated_at: number;
}

export interface ScreenRow {
  bot_id: string;
  screen_id: string;
  display_index: number;
  vnc_port: number | null;
  cdp_port: number | null;
  view_token: string | null;
  control_token: string | null;
  idle_at: number | null;
  ensured_at: number | null;
}

/** The bot's computer row, or null when this bot has never had one. */
export function getComputer(botId: string): BotComputerRow | null {
  return (db.prepare('SELECT * FROM bot_computers WHERE bot_id=?').get(botId) as BotComputerRow | undefined) ?? null;
}

/** Create the row for a bot if it is missing; returns the row either way. */
export function ensureComputerRow(botId: string, kind: ComputerKind, homePath?: string): BotComputerRow {
  const existing = getComputer(botId);
  if (existing) return existing;
  db.prepare('INSERT INTO bot_computers(bot_id,kind,state,home_path,updated_at) VALUES (?,?,?,?,?)').run(
    botId,
    kind,
    'stopped',
    homePath ?? null,
    now(),
  );
  return getComputer(botId)!;
}

export function setComputerState(
  botId: string,
  state: ComputerRuntimeState,
  patch: { containerId?: string | null; error?: string | null; homePath?: string | null } = {},
): void {
  const row = getComputer(botId);
  if (!row) return;
  db.prepare('UPDATE bot_computers SET state=?, container_id=?, error=?, home_path=?, updated_at=? WHERE bot_id=?').run(
    state,
    patch.containerId !== undefined ? patch.containerId : row.container_id,
    patch.error !== undefined ? patch.error : null,
    patch.homePath !== undefined ? patch.homePath : row.home_path,
    now(),
    botId,
  );
}

export function deleteComputerRow(botId: string): void {
  db.prepare('DELETE FROM computer_screens WHERE bot_id=?').run(botId);
  db.prepare('DELETE FROM bot_computers WHERE bot_id=?').run(botId);
}

/** Every bot whose computer is a container (used by startup recovery and shutdown). */
export function dockerComputers(): BotComputerRow[] {
  return db.prepare("SELECT * FROM bot_computers WHERE kind='docker'").all() as BotComputerRow[];
}

/** The bot's screen row, or null when it has none yet. */
export function getScreen(botId: string, screenId?: string): ScreenRow | null {
  const row = screenId
    ? (db.prepare('SELECT * FROM computer_screens WHERE bot_id=? AND screen_id=?').get(botId, screenId) as ScreenRow | undefined)
    : (db.prepare('SELECT * FROM computer_screens WHERE bot_id=? ORDER BY display_index LIMIT 1').get(botId) as ScreenRow | undefined);
  return row ?? null;
}

/** Lowest display index no bot is using, or null when they are all taken. */
export function freeDisplayIndex(limit: number): number | null {
  const taken = new Set((db.prepare('SELECT display_index FROM computer_screens').all() as { display_index: number }[]).map((r) => r.display_index));
  for (let i = 1; i <= limit; i++) if (!taken.has(i)) return i;
  return null;
}

export function saveScreen(row: ScreenRow): void {
  db.prepare(
    `INSERT INTO computer_screens(bot_id,screen_id,display_index,vnc_port,cdp_port,view_token,control_token,idle_at,ensured_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(bot_id) DO UPDATE SET
       screen_id=excluded.screen_id, display_index=excluded.display_index, vnc_port=excluded.vnc_port,
       cdp_port=excluded.cdp_port, view_token=excluded.view_token, control_token=excluded.control_token,
       idle_at=excluded.idle_at, ensured_at=excluded.ensured_at`,
  ).run(
    row.bot_id,
    row.screen_id,
    row.display_index,
    row.vnc_port,
    row.cdp_port,
    row.view_token,
    row.control_token,
    row.idle_at,
    row.ensured_at,
  );
}

export function touchScreen(botId: string, screenId: string, patch: { ensuredAt?: number; idleAt?: number } = {}): void {
  const row = getScreen(botId, screenId);
  if (!row) return;
  saveScreen({
    ...row,
    ensured_at: patch.ensuredAt ?? row.ensured_at,
    idle_at: patch.idleAt ?? row.idle_at,
  });
}

/**
 * Put the bot's screen back on its last display index, or claim a free one. The token stays the
 * same across resumes so a browser already holding the VNC password keeps working.
 */
export function claimScreen(botId: string, limit: number, token: () => string): ScreenRow {
  const existing = getScreen(botId);
  if (existing) return existing;
  const index = freeDisplayIndex(limit);
  if (index === null) throw new Error(`No free display left (${limit} bot screens at most). Remove a bot to free one.`);
  const row: ScreenRow = {
    bot_id: botId,
    screen_id: `screen-${index}`,
    display_index: index,
    vnc_port: 5900 + index,
    cdp_port: 9200 + index,
    view_token: token(),
    control_token: null,
    idle_at: now(),
    ensured_at: null,
  };
  saveScreen(row);
  return row;
}

/** The token a human's control lease carries; null while a person is in control. */
export function setControlToken(botId: string, screenId: string, token: string | null): void {
  db.prepare('UPDATE computer_screens SET control_token=? WHERE bot_id=? AND screen_id=?').run(token, botId, screenId);
}

export function deleteScreen(botId: string, screenId?: string): void {
  if (screenId) db.prepare('DELETE FROM computer_screens WHERE bot_id=? AND screen_id=?').run(botId, screenId);
  else db.prepare('DELETE FROM computer_screens WHERE bot_id=?').run(botId);
}

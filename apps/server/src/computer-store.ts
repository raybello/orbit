import { assignScreen, canAssignScreen, type ComputerStatus, type Screen } from './domain/computer-model.js';
import { db, now } from './db.js';

/**
 * Where each bot's computer lives and what its screen is called. Two small tables:
 *
 *  - bot_computers: one row per bot — its lifecycle state and the Docker container and host home
 *    folder behind it.
 *  - computer_screens: one row per bot screen — its X display index on that computer, the ports the
 *    host reaches it on, and the VNC view token plus the human-control token.
 *
 * Display indexes are allocated globally (one per running screen) so every bot's VNC and CDP ports
 * are unique on the host; that is what lets vnc.ts and the DevTools clients use 127.0.0.1:port.
 */

export type ComputerKind = 'docker';
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

type StateListener = (botId: string) => void;
const stateListeners: StateListener[] = [];

/** Called after a bot's computer changes state (booting, running, suspended…), so the app can be told. */
export function onComputerStateChange(fn: StateListener): void {
  stateListeners.push(fn);
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
  if (row.state !== state) for (const fn of stateListeners) fn(botId);
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

/**
 * The first display a bot may hold. Display 0 is the machine's own console: the allocator has always
 * started at 1, and the port arithmetic below (5900+i, 9200+i) and the container's `DISPLAY=:i` are
 * built on that.
 */
const FIRST_DISPLAY = 1;

/**
 * The display slots the host can hand out, in the shape the pure allocator works with. A screen
 * here is a row in computer_screens, so a display with no row is free; `lastUsedAt` is when its
 * holder last touched it (0 when unknown).
 */
function displaySlots(limit: number): Screen[] {
  const rows = db
    .prepare('SELECT display_index, bot_id, idle_at FROM computer_screens')
    .all() as Pick<ScreenRow, 'display_index' | 'bot_id' | 'idle_at'>[];
  const owner = new Map(rows.map((r) => [r.display_index, r]));
  const screens: Screen[] = [];
  for (let i = FIRST_DISPLAY; i <= limit; i++) {
    const row = owner.get(i);
    screens.push({ screenId: `screen-${i}`, botId: row?.bot_id ?? null, lastUsedAt: row?.idle_at ?? 0 });
  }
  return screens;
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
 *
 * Which display a new bot gets is a decision of the pure allocator (domain/computer-model.ts):
 * hand it the slots and it picks the same lowest free display this used to loop for. A bot that
 * already holds a screen is returned as-is, so it never takes a second slot — the model is
 * idempotent for that case too.
 */
export function claimScreen(botId: string, limit: number, token: () => string): ScreenRow {
  const existing = getScreen(botId);
  if (existing) return existing;

  const screens = displaySlots(limit);
  const computer: ComputerStatus = { status: 'ready', computerId: 'local', screens };
  if (!canAssignScreen(computer)) {
    throw new Error(`No free display left (${limit} bot screens at most). Remove a bot to free one.`);
  }

  const assigned = assignScreen(computer, botId);
  const claimed = assigned.status === 'ready' ? assigned.screens.find((s) => s.botId === botId) : undefined;
  if (!claimed) throw new Error(`assignScreen gave ${botId} no screen on a computer with a free one`);
  const index = FIRST_DISPLAY + screens.findIndex((s) => s.screenId === claimed.screenId);

  const row: ScreenRow = {
    bot_id: botId,
    screen_id: claimed.screenId,
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

import { Hono } from 'hono';
import type { BotComputerStatus, ComputersResponse } from '@orbit/contracts';
import { db } from './db.js';
import { env } from './env.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { computerKindFor } from './computer-provider-registry.js';
import { getComputer, getScreen } from './computer-store.js';
import { getLive } from './store.js';

/**
 * /api/computers: what each of the signed-in user's Bots' computers is doing right now.
 *
 * This is polled by the app while it is open, so it is deliberately cheap and side-effect free: it
 * reads rows the server already owns (bot_computers.state, computers.status, computer_screens) and
 * never opens a VNC connection, probes a socket or starts a container. A provider that cannot answer
 * (Docker down, Orgo unreachable) yields 'unknown' for that bot instead of failing the whole list.
 */

export type ComputerKindOrNone = 'docker' | 'orgo' | 'none';
export type ProviderState = 'awake' | 'sleeping' | 'starting' | 'unknown';

/** The few columns of a bots row this endpoint needs. `kind` is 'room' for a group chat. */
export interface ComputerBotRow {
  id: string;
  name: string;
  kind?: string | null;
}

/**
 * Everything the row builder reads, so it can be tested without HTTP, a database or a provider.
 * `stateFor` may throw: that is how a provider that is unreachable reports itself.
 */
export interface ComputerStatusDeps {
  /** Where this bot's computer lives, or 'none' when it has none at all. */
  kindFor(botId: string): ComputerKindOrNone;
  /** The bot's screen row, or null. Must not boot or create anything. */
  screenIdFor(botId: string): string | null;
  /** The provider's current lifecycle state as a raw string, or null when it is not known. */
  stateFor(botId: string, kind: 'docker' | 'orgo'): string | null;
  /** The bot's agent is running a turn right now. */
  isRunning(botId: string): boolean;
}

/** Raw provider states to the four words the app renders. */
export function providerState(raw: string | null | undefined): ProviderState {
  switch ((raw ?? '').toLowerCase()) {
    case 'running':
      return 'awake';
    case 'booting':
    case 'creating':
    case 'starting':
    case 'resuming':
    case 'suspending':
      return 'starting';
    case 'stopped':
    case 'stopping':
    case 'suspended':
    case 'frozen':
      return 'sleeping';
    default:
      // 'error', 'absent', a missing row, a state this server has never seen: we do not know.
      return 'unknown';
  }
}

/**
 * One row of GET /api/computers, or null for a bot that is not a computer (a room). Pure: no I/O of
 * its own, and a throwing provider only costs that bot its status.
 */
export function computerStatusFor(bot: ComputerBotRow, deps: ComputerStatusDeps): BotComputerStatus | null {
  if (bot.kind === 'room') return null;
  const kind = deps.kindFor(bot.id);
  if (kind === 'none') {
    return {
      botId: bot.id,
      botName: bot.name,
      kind: 'none',
      status: 'unknown',
      isRunning: deps.isRunning(bot.id),
      vncAvailable: false,
      screenId: null,
    };
  }
  const screenId = deps.screenIdFor(bot.id);
  let status: ProviderState;
  try {
    status = providerState(deps.stateFor(bot.id, kind));
  } catch {
    // Docker not running, Orgo unreachable: this bot's status is unknown, everyone else's is fine.
    status = 'unknown';
  }
  return {
    botId: bot.id,
    botName: bot.name,
    kind,
    status,
    isRunning: deps.isRunning(bot.id),
    // There is something to view only when the bot has a computer and a screen on it. Nothing here
    // checks that the VNC server is up: that is what opening the screen does.
    vncAvailable: screenId !== null,
    screenId,
  };
}

/** Every bot that is a computer, in the order given. Rooms drop out. */
export function computerStatusesFor(bots: readonly ComputerBotRow[], deps: ComputerStatusDeps): BotComputerStatus[] {
  const out: BotComputerStatus[] = [];
  for (const bot of bots) {
    const row = computerStatusFor(bot, deps);
    if (row) out.push(row);
  }
  return out;
}

/**
 * The real dependencies for one user: the same rows the rest of the server maintains. Nothing here
 * starts a container or asks Orgo anything — a bot is 'awake' only because the server already knows
 * it is running.
 */
export function computerStatusDeps(userId: string): ComputerStatusDeps {
  return {
    kindFor(botId) {
      const kind = computerKindFor(botId);
      // An Orgo-kind bot on an install with no shared computer has no desktop at all (nothing to
      // wake): that is 'none', not a computer we cannot reach.
      if (kind === 'orgo' && !env.orgoComputerId && !env.localBox) return 'none';
      return kind;
    },
    screenIdFor(botId) {
      // A container's screen lives in computer_screens; a shared Orgo computer's screens live in
      // `screens`. Both are just rows here.
      const own = getScreen(botId);
      if (own) return own.screen_id;
      const shared = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(botId) as { screen_id: string } | undefined;
      return shared?.screen_id ?? null;
    },
    stateFor(botId, kind) {
      if (kind === 'docker') return getComputer(botId)?.state ?? null;
      // The shared computer is one machine for the whole user; its state is on the computers row.
      const row = db.prepare('SELECT status FROM computers WHERE user_id=?').get(userId) as { status: string } | undefined;
      return row?.status ?? null;
    },
    isRunning(botId) {
      return getLive(botId).isRunning;
    },
  };
}

export const computersApi = new Hono<AuthVars>();
computersApi.use('*', requireUser);

computersApi.get('/', (c) => {
  const user = c.get('user');
  // SELECT * rather than named columns: `kind` and `hidden` are added to bots lazily (initRooms,
  // subagents.ts), and this endpoint must answer on a database those have not touched yet. Reading
  // the row and filtering here is also cheaper than listBots(), which maps a whole Bot plus its last
  // conversation row for every bot.
  const rows = db
    .prepare('SELECT * FROM bots WHERE user_id=? ORDER BY is_primary DESC, created_at ASC')
    .all(user.id) as (ComputerBotRow & { hidden?: number | null })[];
  const bots = rows
    .filter((r) => !r.hidden)
    .map((r) => ({ id: r.id, name: r.name, kind: r.kind ?? 'agent' }));
  const body: ComputersResponse = { computers: computerStatusesFor(bots, computerStatusDeps(user.id)) };
  return c.json(body);
});

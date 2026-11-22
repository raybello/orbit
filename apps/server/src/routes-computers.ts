import { Hono } from 'hono';
import type { BotComputerStatus, ComputerRuntimeInfo, ComputersResponse } from '@orbit/contracts';
import { db } from './db.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getComputer, getScreen } from './computer-store.js';
import { getLive } from './store.js';
import { activeRuntimeName, preferredRuntime, setPreferredRuntime } from './computer-runtime-config.js';
import { retireComputerContainers } from './computer-provider-registry.js';
import { appleStatus } from './apple/runtime.js';
import { dockerProblem } from './docker/client.js';
import { looksContainerized } from './docker/reach.js';

/**
 * /api/computers: what each of the signed-in user's Bots' computers is doing right now.
 *
 * This is polled by the app while it is open, so it is deliberately cheap and side-effect free: it
 * reads rows the server already owns (bot_computers.state, computer_screens) and never opens a VNC
 * connection, probes a socket or starts a container. A provider that cannot answer (Docker down)
 * yields 'unknown' for that bot instead of failing the whole list.
 */

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
  /** The bot's screen row, or null. Must not boot or create anything. */
  screenIdFor(botId: string): string | null;
  /** The provider's current lifecycle state as a raw string, or null when it is not known. */
  stateFor(botId: string): string | null;
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
  const screenId = deps.screenIdFor(bot.id);
  let status: ProviderState;
  try {
    status = providerState(deps.stateFor(bot.id));
  } catch {
    // Docker not running: this bot's status is unknown, everyone else's is fine.
    status = 'unknown';
  }
  return {
    botId: bot.id,
    botName: bot.name,
    kind: 'docker',
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
 * starts a container: a bot is 'awake' only because the server already knows it is running.
 */
export function computerStatusDeps(): ComputerStatusDeps {
  return {
    screenIdFor(botId) {
      return getScreen(botId)?.screen_id ?? null;
    },
    stateFor(botId) {
      return getComputer(botId)?.state ?? null;
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
  const body: ComputersResponse = { computers: computerStatusesFor(bots, computerStatusDeps()) };
  return c.json(body);
});

// ------------------------------------------------------------------ runtime choice

async function runtimeInfo(): Promise<ComputerRuntimeInfo> {
  const docker = await dockerProblem();
  const status = await appleStatus();
  const mac = process.platform === 'darwin' && process.arch === 'arm64';
  const inContainer = looksContainerized();
  let appleNote: string | null = null;
  let appleAvailable = false;
  if (!mac) appleNote = 'Needs a Mac with Apple silicon.';
  else if (inContainer) appleNote = 'This server runs inside Docker, which cannot start Apple containers. Use the desktop app’s native stack.';
  else if (!status.installed) appleNote = 'Apple’s container runtime is not installed.';
  else {
    appleAvailable = true;
    if (!status.running) appleNote = 'Its service is stopped; it starts when a Bot’s computer opens.';
  }
  return {
    active: activeRuntimeName(),
    chosen: preferredRuntime(),
    options: [
      { name: 'docker', label: 'Docker', available: docker === null, note: docker },
      {
        name: 'apple',
        label: 'Apple container',
        available: appleAvailable,
        note: appleNote,
        installable: mac && !inContainer && !status.installed,
      },
    ],
  };
}

computersApi.get('/runtime', async (c) => c.json(await runtimeInfo()));

/**
 * Switch runtimes. Every computer is checkpointed and its container removed from the runtime it is
 * on; the home folders are host folders, so each Bot's next open starts a fresh container in the
 * new runtime with the same files and logins.
 */
computersApi.post('/runtime', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { runtime?: string };
  if (body.runtime !== 'docker' && body.runtime !== 'apple') return c.json({ error: 'runtime must be "docker" or "apple"' }, 400);
  const info = await runtimeInfo();
  const target = info.options.find((o) => o.name === body.runtime);
  if (!target?.available) return c.json({ error: target?.note ?? 'that runtime is not available' }, 409);
  // Containers made by the runtime being left are checkpointed and removed first: a stopped one
  // would hold the bot's name (and its display's ports) against the new runtime.
  if (info.active !== body.runtime) await retireComputerContainers();
  setPreferredRuntime(body.runtime);
  return c.json(await runtimeInfo());
});

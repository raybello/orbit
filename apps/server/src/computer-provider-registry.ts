import { db } from './db.js';
import { dockerProvider } from './docker-provider.js';
import { dockerComputers, ensureComputerRow, setComputerState } from './computer-store.js';
import { runtime } from './docker/runtime.js';
import { homeDirFor } from './docker/workspace.js';

/** Every bot's computer is a container of its own (docker-provider.ts). */

/** Message off a caught value, which may be an Error or anything a dependency threw. */
const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

/**
 * Give a new bot its computer row. Called when the bot is created; also idempotent for bots that
 * predate this table.
 */
export function registerBotComputer(botId: string): void {
  ensureComputerRow(botId, 'docker', homeDirFor(botId));
}

/** A deleted bot leaves no container behind. */
export async function releaseBotComputer(botId: string): Promise<void> {
  await dockerProvider.destroy(botId, { wipeWorkspace: true });
}

/**
 * After a crash nothing that was 'running' really is. Containers are stopped (their home folders are
 * bind mounts, so nothing is lost) and the next open starts them again.
 */
export async function recoverComputers(): Promise<void> {
  for (const row of dockerComputers()) {
    if (!['booting', 'running', 'suspending'].includes(row.state)) continue;
    try {
      if (row.container_id) {
        const status = await runtime().status(row.container_id);
        if (!status.exists) {
          setComputerState(row.bot_id, 'stopped', { containerId: null });
          continue;
        }
        if (status.running) await runtime().stop(row.container_id);
      }
      setComputerState(row.bot_id, 'suspended', { error: null });
    } catch (e) {
      console.warn(`[docker] could not recover ${row.bot_id}: ${messageOf(e)}`);
      setComputerState(row.bot_id, 'error', { error: messageOf(e) });
    }
  }
}

/** On shutdown, save every running bot's home folder and stop its container. */
export async function suspendComputers(): Promise<void> {
  for (const row of dockerComputers()) {
    if (row.state !== 'running') continue;
    try {
      await dockerProvider.suspend(row.bot_id);
    } catch (e) {
      console.warn(`[docker] could not suspend ${row.bot_id}: ${messageOf(e)}`);
    }
  }
}

/** Drop containers whose bot no longer exists (a hard delete that skipped the route). */
export async function pruneOrphanContainers(): Promise<void> {
  for (const row of dockerComputers()) {
    const bot = db.prepare('SELECT 1 FROM bots WHERE id=?').get(row.bot_id);
    if (bot) continue;
    if (row.container_id) await runtime().remove(row.container_id).catch(() => undefined);
    setComputerState(row.bot_id, 'stopped', { containerId: null });
  }
}

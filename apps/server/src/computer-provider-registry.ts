import { db } from './db.js';
import { env } from './env.js';
import { orgoProvider } from './computer.js';
import { dockerProvider } from './docker-provider.js';
import { dockerComputers, ensureComputerRow, getComputer, setComputerState, type ComputerKind } from './computer-store.js';
import { containerStatus, removeContainer, stopContainer } from './docker/container.js';
import { homeDirFor } from './docker/workspace.js';
import type { ComputerProvider } from './computer-provider.js';

/**
 * Picks the computer behind a bot. The primary bot always stays where it is (the shared Orgo
 * computer, or this machine with HQ_LOCAL=1): it is somebody's live desktop. Everything else reads
 * its choice from bot_computers, which is set when the bot is created and never changes.
 */

const isPrimary = (botId: string) => (db.prepare('SELECT engine, is_primary FROM bots WHERE id=?').get(botId) as any)?.engine === 'primary'
  || Boolean((db.prepare('SELECT is_primary FROM bots WHERE id=?').get(botId) as any)?.is_primary);

/** Where this bot's computer runs today. */
/**
 * The rule, with no database in the way, so it can be tested: a bot that already has a computer row
 * keeps it; the shared machine wins for the primary bot when one is configured; the setting decides
 * everything else (and `auto`/`docker` means a container per bot).
 */
export function decideComputerKind(input: {
  existing?: ComputerKind;
  isPrimary: boolean;
  sharedComputerAvailable: boolean;
  setting: string;
}): ComputerKind {
  // A bot parked on the shared machine when none is configured (an install that never had Orgo, or
  // one that switched away from it) has no desktop; give it a container like every other bot.
  if (input.existing === 'orgo' && !input.sharedComputerAvailable) return 'docker';
  if (input.existing) return input.existing;
  if (input.isPrimary && input.sharedComputerAvailable) return 'orgo';
  if (input.setting === 'orgo') return 'orgo';
  return 'docker';
}

export function computerKindFor(botId: string): ComputerKind {
  const row = getComputer(botId);
  return decideComputerKind({
    existing: row?.kind,
    isPrimary: isPrimary(botId),
    // With no shared computer configured there is nothing for the primary bot to stay on, so it
    // gets a container too. Without this, a Docker-only install (the desktop app) shows its main
    // bot a permanent "couldn't reach the screen", which reads as a broken app on first launch.
    sharedComputerAvailable: Boolean(env.orgoComputerId) || env.localBox,
    setting: env.computerKind,
  });
}

export function providerFor(botId: string): ComputerProvider {
  return computerKindFor(botId) === 'docker' ? dockerProvider : orgoProvider;
}

/**
 * Give a new bot its computer row. Called when the bot is created, so its provider is fixed from
 * the first screen it ever opens; also idempotent for bots that predate this table.
 */
export function registerBotComputer(botId: string): ComputerKind {
  const kind = computerKindFor(botId);
  if (kind === 'docker') ensureComputerRow(botId, 'docker', homeDirFor(botId));
  return kind;
}

/** A deleted bot leaves no container behind. */
export async function releaseBotComputer(botId: string): Promise<void> {
  if (computerKindFor(botId) !== 'docker') return;
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
        const status = await containerStatus(row.container_id);
        if (!status.exists) {
          setComputerState(row.bot_id, 'stopped', { containerId: null });
          continue;
        }
        if (status.running) await stopContainer(row.container_id);
      }
      setComputerState(row.bot_id, 'suspended', { error: null });
    } catch (e: any) {
      console.warn(`[docker] could not recover ${row.bot_id}: ${e?.message ?? e}`);
      setComputerState(row.bot_id, 'error', { error: String(e?.message ?? e) });
    }
  }
}

/** On shutdown, save every running bot's home folder and stop its container. */
export async function suspendComputers(): Promise<void> {
  for (const row of dockerComputers()) {
    if (row.state !== 'running') continue;
    try {
      await dockerProvider.suspend(row.bot_id);
    } catch (e: any) {
      console.warn(`[docker] could not suspend ${row.bot_id}: ${e?.message ?? e}`);
    }
  }
}

/** Drop containers whose bot no longer exists (a hard delete that skipped the route). */
export async function pruneOrphanContainers(): Promise<void> {
  for (const row of dockerComputers()) {
    const bot = db.prepare('SELECT 1 FROM bots WHERE id=?').get(row.bot_id);
    if (bot) continue;
    if (row.container_id) await removeContainer(row.container_id).catch(() => undefined);
    setComputerState(row.bot_id, 'stopped', { containerId: null });
  }
}

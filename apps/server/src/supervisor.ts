/**
 * The sandbox-supervisor: a second process beside the API whose only job is to keep bot containers
 * from outliving their welcome.
 *
 * Why it exists: the API suspends idle containers itself (startDockerIdleSuspender), but when the
 * API container stops, crashes, or is replaced, nothing would ever pause the containers it left
 * running — and each one holds a desktop, a browser and 2 GB of RAM on the host.
 *
 * It never opens a port and never serves anything: two HTTP servers on one SQLite file and one
 * Docker socket would race each other for no benefit. It reads the same database and talks to the
 * same Docker daemon as the API, so run it with the same DB_PATH, DOCKER_SOCKET and
 * COMPUTER_HOME_DIR (see infra/compose).
 */
import { createLogger } from '@orbit/logger';
// The schema additions (bot_computers, computer_screens) live in db-config, not db.ts, and are
// idempotent. Without this the supervisor cannot read a database the API has not opened yet.
import './db-config.js';
import { dockerComputers } from './computer-store.js';
import { suspendComputers } from './computer-provider-registry.js';
import { startDockerIdleSuspender } from './docker-provider.js';
import { env } from './env.js';

const log = createLogger({ scope: 'supervisor' });
const startedAt = Date.now();

// The one piece of real work: every sweep suspends containers with no viewer and no turn running
// for COMPUTER_IDLE_TIMEOUT_MIN (docker-provider owns that policy; nothing is reimplemented here).
const stopSuspender = startDockerIdleSuspender();

// Deliberately not unref'd: this interval is what keeps the process alive between sweeps.
const heartbeat = setInterval(() => {
  const rows = dockerComputers();
  const running = rows.filter((r) => r.state === 'running').length;
  const suspended = rows.filter((r) => r.state === 'suspended').length;
  log.info(
    `alive ${Math.round((Date.now() - startedAt) / 1000)}s; ` +
      `computers: ${rows.length} (running ${running}, suspended ${suspended}); ` +
      `idle timeout ${env.computerIdleTimeoutMin} min`,
  );
}, 60_000);

/**
 * SIGTERM is what `docker stop` (and so every normal shutdown) sends. Wait for the suspends before
 * exiting: a bot container's home folder is a host bind mount, so suspending is cheap, but a
 * half-finished checkpoint is not something to leave behind.
 */
const SHUTDOWN_DEADLINE_MS = 90_000;
let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  stopSuspender();
  log.info(`${signal}: suspending running bot computers`);
  const deadline = setTimeout(() => {
    log.warn('shutdown deadline reached; exiting with containers possibly still running');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref?.();
  try {
    await suspendComputers();
    log.info('all running bot computers suspended');
  } catch (e: any) {
    log.warn(`shutdown suspend failed: ${e?.message ?? e}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// Nothing here throws at start-up unless the environment is unusable; log it rather than exit silently.
process.on('unhandledRejection', (e: any) => log.error(`unhandled rejection: ${e?.message ?? e}`));

log.info(`sandbox supervisor up (no HTTP port); ${dockerComputers().length} bot computer(s) known`);

import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { env } from './env.js';
import { createApp } from './api/app.js';
import { attachVncRelay } from './vnc.js';
import { attachEngineTerminal } from './engine-terminal.js';
import { attachLocalCallRelay } from './voice-local-session.js';
import { attachAudiocppCallRelay } from './voice-audiocpp-session.js';
import { warmVoiceIfReady } from './voice-local.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { retireGoogleOAuth } from './retire-google-oauth.js';
import { startCalendarSync } from './calendar/mirror.js';
import { initProactive } from './proactive.js';
import { composioEnabled } from './composio.js';
import { connectionWatch } from './core/connection-watch.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { expireStaleApprovals } from './agent/loop.js';
import { enqueue, resumeRuns } from './core/turn-queue.js';
import { settleOrphanToolRows } from './store.js';
import { desSelfTest } from './lib/des.js';
import { importPrimaryHome, initEngines, startSubscriptionSync, syncAllManagedAuth } from './engine.js';
import { recoverComputers, suspendComputers } from './computer-provider-registry.js';
import { startDockerIdleSuspender } from './docker-provider.js';
import { renameLegacyPrimary } from './bot-admin.js';

/**
 * Boot: the HTTP app comes from api/app.ts (so a test can build it without any of this), and
 * everything below is the part that must only happen in a real server process.
 */

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
// Installs seeded before the coordinator was renamed still carry the old name, and the primary agent
// is the row every other surface addresses by name.
renameLegacyPrimary();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();

/** Message off a caught value, which may be an Error or anything a dependency threw. */
const messageOf = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e);

const app = createApp();

const server = serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[grokbot] server on http://localhost:${info.port}`));
attachVncRelay(server as unknown as Server);
attachEngineTerminal(server as unknown as Server);
attachLocalCallRelay(server as unknown as Server);
attachAudiocppCallRelay(server as unknown as Server);
// On-device voice, when this host has the models: loading the engines now keeps the first call fast.
void warmVoiceIfReady();
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
  if (composioEnabled()) connectionWatch.start();
  // The Google Calendar mirror, every five minutes (only with DB_ENCRYPTION_KEY set).
  if (composioEnabled()) startCalendarSync();
} else console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
// The direct Google OAuth integration is gone; revoke and drop anything an older version stored.
void retireGoogleOAuth().catch((e) => console.warn('[google-oauth] retire failed', (e as Error).message));
// The primary's home is where every agent's credentials come from, so it is seeded first.
importPrimaryHome();
// Every managed bot's credentials come from the primary agent, so the sync has to land *before* the
// gateways start: a gateway reads its .env once, at start, and one started against a stale home
// answers "not connected to any AI provider yet" for the rest of its life.
try {
  await syncAllManagedAuth();
  console.log('[engine] auth sync complete');
} catch (e) {
  console.warn(`[engine] auth sync failed: ${messageOf(e)}`);
}
initEngines();
// Work that was queued, running or waiting to retry when the server stopped carries on. Not with
// the scheduler off: a second dev server on the same database must not run the same turns.
if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
  settleOrphanToolRows();
  const resumed = resumeRuns();
  if (resumed) console.log(`[supervisor] resuming ${resumed} interrupted run(s)`);
}
// Subscription sign-ins are inherited as access tokens, so they have to be re-read as the primary
// agent refreshes its own. A bot's gateway picks the new token up from auth.json without a restart.
startSubscriptionSync();
// Containers left "running" by a crash are paused, not trusted: each bot's home folder on the host
// is what survives, and the next open starts its container again.
void recoverComputers().catch((e) => console.warn(`[docker] startup recovery failed: ${e?.message ?? e}`));
startDockerIdleSuspender();

// On the way out, save each running bot's home folder and stop its container.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[grokbot] ${signal}: suspending bot computers`);
  try {
    await suspendComputers();
  } catch (e) {
    console.warn(`[docker] shutdown suspend failed: ${messageOf(e)}`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

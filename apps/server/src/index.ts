import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { ORBIT_HEADERS, type HealthResponse } from '@orbit/contracts';
import { env } from './env.js';
import { api } from './routes.js';
import { stackTokenMatches } from './lib/stack.js';
import { attachVncRelay } from './vnc.js';
import { initRoutines } from './routines.js';
import { initTriggers } from './triggers.js';
import { initProactive } from './proactive.js';
import { initSubagents } from './agent/subagents.js';
import { initRooms } from './agent/rooms.js';
import { checkinsApi } from './routes-proactive.js';
import { roomsApi } from './routes-rooms.js';
import { enqueue, expireStaleApprovals } from './agent/loop.js';
import { desSelfTest } from './lib/des.js';
import { configApi } from './routes-config.js';
import { calendarApi } from './routes-calendar.js';
import { filesApi } from './routes-files.js';
import { computersApi } from './routes-computers.js';
import { skillsApi } from './routes-skills.js';
import { startIdleWatcher } from './idle.js';
import { mcpApi } from './mcp.js';
import { initEngines, syncAllManagedAuth } from './engine.js';
import { recoverComputers, suspendComputers } from './computer-provider-registry.js';
import { startDockerIdleSuspender } from './docker-provider.js';

if (!desSelfTest()) throw new Error('DES self-test failed');
initSubagents();
initRooms();
// Approvals wait in memory; whatever was still open when the last process stopped can no longer be answered.
expireStaleApprovals();

const app = new Hono();
/**
 * Public liveness probe. `stackToken: 'verified'` is only ever claimed when the caller proved it
 * holds this stack's STACK_TOKEN (lib/stack.ts); a wrong or absent header simply omits the field.
 */
app.get('/api/health', (c) => {
  const stackToken = stackTokenMatches(c.req.header(ORBIT_HEADERS.stackToken));
  const body: HealthResponse = {
    ok: true,
    version: env.version,
    engine: 'hermes',
    uptimeMs: Math.round(process.uptime() * 1000),
    ...(stackToken ? { stackToken: 'verified' as const } : {}),
  };
  return c.json(body);
});
// The app's tools for the agent engines (MCP).
app.route('/mcp', mcpApi);
app.route('/api/checkins', checkinsApi);
app.route('/api/rooms', roomsApi);
app.route('/api', api);
app.route('/api', configApi);
// Calendar (routines + occurrences), Skills (MCP servers) and the two routers that own a prefix.
app.route('/api', calendarApi);
app.route('/api', skillsApi);
app.route('/api/files', filesApi);
app.route('/api/computers', computersApi);

// Serve the built web app in production.
const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../web/dist');
if (fs.existsSync(webDist)) {
  // index.html must never be cached by Electron across container rebuilds: the shell
  // references content-hashed assets, so a stale shell loads the wrong (or missing) JS.
  const indexHtml = () => fs.readFileSync(path.join(webDist, 'index.html'), 'utf8');
  const noStore = { 'Cache-Control': 'no-store' } as const;
  app.get('/', (c) => c.html(indexHtml(), 200, noStore));
  app.get('/index.html', (c) => c.html(indexHtml(), 200, noStore));
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get('*', (c) => c.html(indexHtml(), 200, noStore));
}

const server = serve({ fetch: app.fetch, port: env.port }, (info) => console.log(`[grokbot] server on http://localhost:${info.port}`));
attachVncRelay(server as unknown as Server);
// GROKBOT_NO_SCHEDULER=1 for extra dev/test servers sharing a database copy, so routines and triggers don't fire twice.
if (process.env.GROKBOT_NO_SCHEDULER !== '1') {
  initRoutines(enqueue);
  void initTriggers(enqueue);
initProactive(enqueue);
} else console.log('[grokbot] scheduler disabled (GROKBOT_NO_SCHEDULER=1)');
startIdleWatcher();
initEngines();
// Every managed bot's model credentials come from the primary agent; bring them in line at boot so a
// key the user added or rotated later still reaches the bots that were created before it.
void syncAllManagedAuth()
  .then((n) => n && console.log(`[engine] auth sync: ${n} managed bot(s) updated`))
  .catch((e) => console.warn(`[engine] auth sync failed: ${e?.message ?? e}`));
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
  } catch (e: any) {
    console.warn(`[docker] shutdown suspend failed: ${e?.message ?? e}`);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

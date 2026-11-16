import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ORBIT_HEADERS, type HealthResponse } from '@orbit/contracts';
import { env } from '../env.js';
import { api } from '../routes.js';
import { stackTokenMatches } from '../lib/stack.js';
import { checkinsApi } from '../routes-proactive.js';
import { roomsApi } from '../routes-rooms.js';
import { configApi } from '../routes-config.js';
import { calendarApi } from '../routes-calendar.js';
import { filesApi } from '../routes-files.js';
import { computersApi } from '../routes-computers.js';
import { skillsApi } from '../routes-skills.js';
import { vaultApi } from '../routes-vault.js';
import { mcpApi } from '../mcp.js';

/**
 * The HTTP app, assembled and handed back.
 *
 * Everything that answers a request is here; everything that starts something (engines, gateways,
 * routine and trigger schedulers, the idle watcher, container recovery, voice warm-up) stays in
 * index.ts. That split is what lets a test import createApp() and drive the real routes without
 * booting a single background process.
 *
 * Mount order matters and mirrors index.ts exactly: /api/health first, then the routers, and the
 * built web app last so its catch-all cannot shadow an API route.
 */
export function createApp(): Hono {
  const app = new Hono();

  /**
   * Errors become JSON, because every client parses `{ error }`. An HTTPException keeps its own
   * status (the body schemas use 400); anything else is a bug and stays the 500 it has always been,
   * logged and answered as plain text so no client sees a new shape for an internal failure.
   */
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error('[grokbot] unhandled error', err);
    return c.text('Internal Server Error', 500);
  });

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
  // The Bot Vault (saved logins and the secure form).
  app.route('/api', vaultApi);
  app.route('/api/files', filesApi);
  app.route('/api/computers', computersApi);

  // Serve the built web app in production.
  // dist/api/app.js and src/api/app.ts sit at the same depth under apps/server, so one path fits both.
  const webDist = path.resolve(new URL('.', import.meta.url).pathname, '../../../web/dist');
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

  return app;
}

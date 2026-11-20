import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { db } from './db.js';
import { env } from './env.js';
import { engineHome, forgetEngineOptions } from './engine.js';
import { userFromCookieHeader, userFromToken } from './lib/auth.js';
import { signInArgs, terminalSpawn } from './domain/engine-signin.js';

/**
 * The Engine tab's sign-in terminal: /api/bots/:id/engine/terminal?provider=<slug>.
 *
 * Hermes and every agent's home live where this server runs (the stack's container), not on a
 * Bot's own computer, so the terminal runs here: Hermes' own sign-in or model chooser for that one
 * agent, never a shell. Bytes go both ways over the socket; closing it ends the command.
 */

/** One sign-in per Bot at a time: two would write the same credentials file. */
const running = new Map<string, ChildProcess>();

const refuse = (socket: import('node:stream').Duplex, status: string) => {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
};

export function attachEngineTerminal(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/engine\/terminal$/);
    if (!m) return; // not ours
    const user = userFromCookieHeader(req.headers.cookie) ?? userFromToken(url.searchParams.get('token') ?? undefined);
    const bot = user ? (db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as { id: string } | undefined) : undefined;
    if (!user || !bot) return refuse(socket, '401 Unauthorized');
    const home = engineHome(bot.id);
    const args = signInArgs(url.searchParams.get('provider'));
    if (!home) return refuse(socket, '409 Conflict');
    if (!args) return refuse(socket, '400 Bad Request');
    if (running.has(bot.id)) return refuse(socket, '409 Conflict');
    wss.handleUpgrade(req, socket, head, (client) => session(client, bot.id, home, args));
  });
}

function session(client: WebSocket, botId: string, home: string, args: string[]) {
  const { file, args: spawnArgs } = terminalSpawn([env.hermesBin, ...args]);
  const child = spawn(file, spawnArgs, {
    env: { ...process.env, HERMES_HOME: home, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.set(botId, child);

  const send = (data: Buffer | string) => { if (client.readyState === client.OPEN) client.send(data); };
  child.stdout?.on('data', send);
  child.stderr?.on('data', send);
  client.on('message', (data: Buffer) => { child.stdin?.write(data); });
  client.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });

  const finish = (code: number | null, error?: string) => {
    if (running.get(botId) === child) running.delete(botId);
    // A new sign-in changes which models this agent can use.
    forgetEngineOptions(botId);
    send(`\r\n\x1b[2m${error ? `Could not start Hermes: ${error}` : `Finished${code ? ` (exit ${code})` : ''}.`}\x1b[0m\r\n`);
    if (client.readyState === client.OPEN) client.close(1000, code === 0 ? 'done' : 'failed');
  };
  child.on('exit', (code) => finish(code));
  child.on('error', (e) => finish(null, e.message));
}

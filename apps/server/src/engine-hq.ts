import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { env } from './env.js';

// ─── private helpers (copies of engine.ts utilities; kept here to avoid a circular import) ────

const asBlock = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

function readYaml(file: string): Record<string, unknown> {
  try { return (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>; } catch { return {}; }
}

function gatewayPid(home: string): number | null {
  let raw = '';
  try { raw = fs.readFileSync(path.join(home, 'gateway.pid'), 'utf8').trim(); } catch { return null; }
  let pid = NaN;
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'number') pid = j;
    else {
      if (j?.hermes_home && path.resolve(j.hermes_home) !== path.resolve(home)) return null;
      pid = Number(j?.pid);
    }
  } catch { pid = Number(raw); }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  try {
    if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('gateway')) return null;
  } catch { /* no /proc: trust the pid file */ }
  return pid;
}

// ─── public: token ────────────────────────────────────────────────────────────

/** Token a bot's Hermes agent presents to this server's MCP endpoint. `primary` names the primary bot. */
export function mcpToken(botId: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(`mcp:${botId}`).digest('hex');
}

// ─── HQ lease ────────────────────────────────────────────────────────────────

/** How long (ms) a primary-hq lease stays valid without a heartbeat before another server may take it. */
export const HQ_LEASE_EXPIRY_MS = 5 * 60_000;

export interface HqLease { pid: number; port: number; ts: number }

function hqLeaseFile(): string {
  return path.join(env.hermesHome, 'orbit-hq.lease');
}

export function readHqLease(): HqLease | null {
  try {
    const j = JSON.parse(fs.readFileSync(hqLeaseFile(), 'utf8')) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const { pid, port, ts } = j as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof port !== 'number' || typeof ts !== 'number') return null;
    return { pid, port, ts };
  } catch { return null; }
}

function writeHqLease() {
  try { fs.writeFileSync(hqLeaseFile(), JSON.stringify({ pid: process.pid, port: env.port, ts: Date.now() })); }
  catch { /* best-effort: a read-only home is unusual but not fatal */ }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Acquire or renew the primary-hq write lease. Returns true when this process is the owner.
 *
 * A lease file next to the Hermes config tracks which Orbit server instance is allowed to write
 * mcp_servers.hq and send SIGHUP. When two servers run on one machine (the desktop app plus a dev
 * server, say), the second sees a live lease and skips both steps — preventing the gateway
 * restart loop that happened when each rewrite sent SIGHUP and the gateway bounced 162 times in
 * five hours. The owner refreshes the timestamp on every interval; if it dies the lease expires
 * after HQ_LEASE_EXPIRY_MS and the next server takes over.
 */
export function acquireHqLease(): boolean {
  const lease = readHqLease();
  const ours =
    !lease
    || (lease.pid === process.pid && lease.port === env.port)
    || Date.now() - lease.ts >= HQ_LEASE_EXPIRY_MS
    || !processAlive(lease.pid);
  if (ours) writeHqLease();
  return ours;
}

/**
 * Inject the hq MCP server entry into the primary Hermes config so it can reach the app's tools.
 *
 * The URL must be the one the *host* can dial (env.primaryMcpBaseUrl), not the container-facing
 * MCP_BASE_URL: a config pointing at host.docker.internal:8787 leaves the primary agent without a
 * single app tool, and it then tells the user it cannot message other Bots.
 *
 * It names /mcp/primary, not the bot's id: the entry then depends only on this server's address and
 * session secret, so a new primary bot (a fresh database, a reset stack) needs no rewrite. That
 * matters because the gateway only re-reads its config on restart, and a server in Docker cannot
 * signal a gateway on the host.
 *
 * Returns true when the config was changed on disk (URL or authorization token differed), so callers
 * know whether to signal the primary gateway to reload.
 */
export function syncPrimaryHqConfig(): boolean {
  const cfgFile = path.join(env.hermesHome, 'config.yaml');
  if (!fs.existsSync(cfgFile)) return false;
  const cfg = readYaml(cfgFile);
  const hqUrl = `${env.primaryMcpBaseUrl}/mcp/primary`;
  const expectedAuth = `Bearer ${mcpToken('primary')}`;
  const current = asBlock(asBlock(cfg.mcp_servers).hq);
  const currentAuth = String(asBlock(current.headers).Authorization ?? '');
  const servers = asBlock(cfg.mcp_servers);
  const hasStaleOrbit = 'orbit' in servers;
  if (current.url === hqUrl && currentAuth === expectedAuth && !hasStaleOrbit) return false;
  const headers = asBlock(current.headers);
  const keep = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'));
  const { orbit: _orbit, ...otherServers } = servers;
  cfg.mcp_servers = {
    ...otherServers,
    hq: { ...current, url: hqUrl, headers: { ...keep, Authorization: expectedAuth }, timeout: 1800, connect_timeout: 30 },
  };
  fs.writeFileSync(cfgFile, YAML.stringify(cfg), 'utf8');
  return true;
}

/**
 * Ask the primary Hermes gateway to reload its config by sending it SIGHUP.
 *
 * Python's default SIGHUP handler terminates the process; the Hermes supervisor detects the exit and
 * restarts the gateway, which then re-reads config.yaml and re-connects every MCP server. This is
 * the lightest path to picking up a changed hq URL or token without a full manual restart.
 *
 * Returns true when the signal was delivered (the gateway was running), false when it was not (a
 * fresh install where Hermes has not started yet, or one that crashed). The caller may log but
 * should not treat false as an error: the gateway will pick up the config on its next start.
 */
export function signalPrimaryGateway(): boolean {
  const pid = gatewayPid(env.hermesHome);
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGHUP');
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the primary bot's hq MCP entry current on a timer.
 *
 * Two races make a one-shot sync at startup insufficient:
 *   1. The Hermes desktop app rewrites config.yaml when the user saves any setting, restoring
 *      whatever the gateway has in memory — which may be a stale URL or token from before this
 *      server's last update.
 *   2. The session secret can rotate between server restarts, invalidating the token without
 *      changing the URL (so the old URL-only check silently left a 401 in place forever).
 *
 * Every interval this function re-reads config.yaml, compares both URL and token, and writes+signals
 * only when something changed — so a healthy install never touches the config and never restarts
 * the gateway needlessly.
 */
export function startPrimaryHqSync(intervalMs = 2 * 60_000): NodeJS.Timeout {
  let loggedConflict = false;

  const run = () => {
    if (!acquireHqLease()) {
      if (!loggedConflict) {
        const other = readHqLease();
        console.log(`[engine] primary hq sync: another Orbit server (pid ${other?.pid}, port ${other?.port}) owns the config; will retry after lease expires`);
        loggedConflict = true;
      }
      return;
    }
    loggedConflict = false;
    try {
      const changed = syncPrimaryHqConfig();
      if (!changed) return;
      const signaled = signalPrimaryGateway();
      console.log(`[engine] primary hq config refreshed (url/token updated)${signaled ? '; gateway signaled to reload' : '; gateway not running yet'}`);
    } catch (e) {
      console.warn(`[engine] primary hq sync failed: ${messageOf(e)}`);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}

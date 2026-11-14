import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { SkillEntry } from '@orbit/contracts';
import { db } from './db.js';
import { env } from './env.js';
import { engineKind, managedHome, readYaml, writePrivate } from './engine.js';

/**
 * Skills are Hermes `mcp_servers` entries. The primary agent's config.yaml is the source of truth:
 * it lists every skill, and each managed bot inherits that map when its home is created (see
 * SHARED_CONFIG in engine.ts). Here we read that list per bot and let the app remove or restore one
 * entry in a managed bot's own config.
 */

/** The MCP server the app injects into every Hermes config so the agent can reach Orbit's tools. */
const APP_SERVER = 'hq';

const asMap = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};

/** A bot's `mcp_servers` map: {} when the file or the key is missing. */
export function readMcpServers(configPath: string): Record<string, any> {
  return asMap(readYaml(configPath)?.mcp_servers);
}

/** How Hermes would reach a server: an HTTP endpoint, a local process, or something we can't tell. */
export function mcpServerType(entry: any): 'http' | 'stdio' | 'unknown' {
  if (!entry || typeof entry !== 'object') return 'unknown';
  if (typeof entry.url === 'string' && entry.url.trim()) return 'http';
  if (typeof entry.command === 'string' && entry.command.trim()) return 'stdio';
  return 'unknown';
}

const primaryConfigPath = () => path.join(env.hermesHome, 'config.yaml');

/** Where this bot keeps its Hermes config. The primary agent's home belongs to someone else: we only read it. */
function botConfigPath(botId: string): string | null {
  const kind = engineKind(botId);
  if (kind === 'primary') return primaryConfigPath();
  if (kind === 'managed') return path.join(managedHome(botId), 'config.yaml');
  return null;
}

/**
 * Every skill the primary agent knows about, with which of the user's bots have it enabled.
 * A managed bot "has" a skill when its config.yaml still carries that mcp_servers entry.
 */
export function getSkillEntries(userId: string): SkillEntry[] {
  // Only agents have a Hermes config to read; a group chat (engine NULL) has none.
  const bots = db
    .prepare(
      "SELECT id, name, engine FROM bots WHERE user_id=? AND engine IN ('primary','managed') " +
        "ORDER BY CASE WHEN engine='primary' THEN 1 ELSE 0 END DESC, created_at ASC",
    )
    .all(userId) as any[];

  const primary = readMcpServers(primaryConfigPath());
  const names = Object.keys(primary).filter((n) => n !== APP_SERVER);

  const configs = new Map<string, Record<string, any>>();
  for (const b of bots) {
    const file = botConfigPath(b.id);
    configs.set(b.id, b.engine === 'primary' ? primary : file ? readMcpServers(file) : {});
  }

  return names.map((name): SkillEntry => {
    const def = asMap(primary[name]);
    return {
      name,
      type: mcpServerType(def),
      url: typeof def.url === 'string' && def.url.trim() ? def.url : null,
      description: typeof def.description === 'string' && def.description.trim() ? def.description : null,
      // The primary agent's config is where skills come from; it is never toggled from here.
      primaryEnabled: true,
      bots: bots.map((b) => ({
        botId: b.id,
        botName: b.name,
        enabled: b.engine === 'primary' ? true : Object.prototype.hasOwnProperty.call(configs.get(b.id) ?? {}, name),
      })),
    };
  });
}

/** The SkillEntry for one name, for a PUT's response. null when the primary agent does not define it. */
export function getSkillEntry(userId: string, serverName: string): SkillEntry | null {
  return getSkillEntries(userId).find((s) => s.name === serverName) ?? null;
}

/**
 * Turn one skill on or off for a managed bot by adding or removing its `mcp_servers` entry. Every
 * other key in that config is written back untouched. The primary agent has no off switch.
 */
export function setMcpServerEnabled(botId: string, serverName: string, enabled: boolean): void {
  if (!serverName) throw new Error('A skill name is required.');
  if (serverName === APP_SERVER) throw new Error(`"${APP_SERVER}" is the app's own connection to this bot and cannot be changed.`);

  const kind = engineKind(botId);
  if (!kind) throw new Error('This bot has no agent, so it has no skills.');
  if (kind === 'primary') throw new Error("The primary agent's skills are read-only. They come from its own Hermes config.");

  const file = path.join(managedHome(botId), 'config.yaml');
  if (!fs.existsSync(file)) throw new Error(`This bot has no Hermes config yet (${file}). Start it once, then try again.`);

  const cfg = asMap(readYaml(file));
  const servers = asMap(cfg.mcp_servers);

  if (!enabled) {
    if (!Object.prototype.hasOwnProperty.call(servers, serverName)) return;
    delete servers[serverName];
  } else {
    const source = readMcpServers(primaryConfigPath())[serverName];
    if (source === undefined) throw new Error(`The primary agent does not define a skill named "${serverName}".`);
    servers[serverName] = structuredClone(source);
  }

  cfg.mcp_servers = servers;
  writePrivate(file, YAML.stringify(cfg));
}

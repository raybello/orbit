import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { db } from './db.js';
import { env } from './env.js';
import { engineRunning, managedHome, restartEngine } from './engine.js';
import { asBlock, dotenvText, parseDotenv, readDotenv, readYaml, writePrivate, type HermesConfig } from './hermes-files.js';
const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

/**
 * The shared Hermes settings: the primary agent's `.env` and `config.yaml` (imported once from the
 * person's own Hermes), which every managed bot starts from. Settings → API keys edits them as text;
 * a save writes the primary's files as typed, copies each key the save changed into every managed
 * bot, and restarts the running gateways so they read it.
 *
 * Only what the save changed is copied: a key a bot holds that the person did not touch stays the
 * bot's own. Keys that belong to one agent (its API server, its chat-platform tokens, its paths) are
 * never copied; the server writes those per bot.
 */

export interface SharedSettings { env: string; config: string }
export type SettingsFile = keyof SharedSettings;
export interface SettingsError { file: SettingsFile; line: number | null; message: string }

/** Env vars one agent owns: its API server, browser, subscription token (inherited separately) and chat platforms. */
const PER_AGENT_ENV = /^(API_SERVER_|BROWSER_CDP_URL$|ANTHROPIC_TOKEN(_OWN)?$|(DISCORD|TELEGRAM|SLACK|WHATSAPP|SIGNAL|MATRIX|MATTERMOST|EMAIL|SMS|TWILIO|HOMEASSISTANT|DINGTALK|FEISHU|WECOM|WEIXIN|BLUEBUBBLES|QQ)_)/;
/** Config blocks one agent owns, or that Hermes and this server write per agent. */
const PER_AGENT_CONFIG = new Set(['_config_version', 'platforms', 'platform_toolsets', 'gateway', 'terminal', 'browser', 'database', 'desktop', 'compression']);
/** The bot's own connection to the app. */
const OWN_MCP = 'hq';

const files = () => ({ env: path.join(env.primaryHome, '.env'), config: path.join(env.primaryHome, 'config.yaml') });

export function readSharedSettings(): SharedSettings {
  const f = files();
  const read = (p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  return { env: read(f.env), config: read(f.config) };
}

/** Why this text cannot be saved, or null when it can. Nothing is written for a save with an error. */
export function checkSettings(s: Partial<SharedSettings>): SettingsError | null {
  if (s.env !== undefined) {
    const lines = s.env.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l || l.startsWith('#')) continue;
      if (!/^(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)) return { file: 'env', line: i + 1, message: 'Expected KEY=value' };
    }
  }
  if (s.config !== undefined) {
    const doc = YAML.parseDocument(s.config);
    const err = doc.errors[0];
    if (err) return { file: 'config', line: err.linePos?.[0]?.line ?? null, message: err.message.split('\n')[0] };
    const v = doc.toJS() as unknown;
    if (v !== null && v !== undefined && (typeof v !== 'object' || Array.isArray(v))) return { file: 'config', line: 1, message: 'The config must be a mapping of keys to values' };
  }
  return null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every key whose value differs between two maps; a key missing on one side counts. */
const changedKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));

/** A managed bot's .env with the save's env changes applied. A removed key goes only where the bot held the old value. */
export function applyEnvChanges(bot: Record<string, string>, before: Record<string, string>, after: Record<string, string>): Record<string, string> {
  const out = { ...bot };
  for (const k of changedKeys(before, after)) {
    if (PER_AGENT_ENV.test(k)) continue;
    if (k in after) out[k] = after[k];
    else if (out[k] === before[k]) delete out[k];
  }
  return out;
}

/** A managed bot's config with the save's config changes applied, keeping the bot's own app connection. */
export function applyConfigChanges(bot: HermesConfig, before: HermesConfig, after: HermesConfig): HermesConfig {
  const out: HermesConfig = { ...bot };
  for (const k of changedKeys(before, after)) {
    if (PER_AGENT_CONFIG.has(k)) continue;
    if (k === 'mcp_servers') {
      const was = asBlock(before.mcp_servers);
      const now = asBlock(after.mcp_servers);
      const mine = { ...asBlock(bot.mcp_servers) };
      for (const name of changedKeys(was, now)) {
        if (name === OWN_MCP) continue;
        if (name in now) mine[name] = now[name];
        else delete mine[name];
      }
      out.mcp_servers = mine;
      continue;
    }
    if (k in after) out[k] = after[k];
    else delete out[k];
  }
  return out;
}

/**
 * Save the shared settings and hand the change to every managed bot. Gateways that are running are
 * restarted (in the background) so they read it; the primary's too when its own files changed.
 * Returns the bots whose files changed and how many gateways are restarting.
 */
export function saveSharedSettings(next: Partial<SharedSettings>): { updated: string[]; restarting: number } {
  const f = files();
  const beforeEnv = readDotenv(f.env);
  const beforeCfg = readYaml(f.config);
  if (next.env !== undefined) writePrivate(f.env, next.env.endsWith('\n') || !next.env ? next.env : `${next.env}\n`);
  if (next.config !== undefined) writePrivate(f.config, next.config);
  const afterEnv = next.env !== undefined ? parseDotenv(next.env) : beforeEnv;
  const afterCfg: HermesConfig = next.config !== undefined ? ((YAML.parse(next.config) ?? {}) as HermesConfig) : beforeCfg;

  const bots = db.prepare("SELECT id, engine FROM bots WHERE engine IN ('primary','managed')").all() as { id: string; engine: string }[];
  const updated: string[] = [];
  const restart: string[] = [];
  const primaryChanged = !same(beforeEnv, afterEnv) || !same(beforeCfg, afterCfg);
  for (const b of bots) {
    try {
      let changed = b.engine === 'primary' && primaryChanged;
      if (b.engine === 'managed') {
        const home = managedHome(b.id);
        if (!fs.existsSync(home)) continue;
        const envFile = path.join(home, '.env');
        const botEnv = readDotenv(envFile);
        const nextEnv = applyEnvChanges(botEnv, beforeEnv, afterEnv);
        if (!same(botEnv, nextEnv)) { writePrivate(envFile, dotenvText(nextEnv)); changed = true; }
        const cfgFile = path.join(home, 'config.yaml');
        const botCfg = readYaml(cfgFile);
        const nextCfg = applyConfigChanges(botCfg, beforeCfg, afterCfg);
        if (!same(botCfg, nextCfg)) { writePrivate(cfgFile, YAML.stringify(nextCfg)); changed = true; }
        if (changed) updated.push(b.id);
      }
      if (changed && engineRunning(b.id)) restart.push(b.id);
    } catch (e) {
      console.warn(`[settings] could not update ${b.id}: ${messageOf(e)}`);
    }
  }
  for (const id of restart) {
    void restartEngine(id).catch((e) => console.warn(`[settings] restart ${id} failed: ${messageOf(e)}`));
  }
  return { updated, restarting: restart.length };
}

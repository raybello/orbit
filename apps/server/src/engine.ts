import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { displayFor } from './box.js';
import { cdpUrlFor, screenFor } from './computer.js';
import { claimScreen } from './computer-store.js';
import { computerKindFor, providerFor } from './computer-provider-registry.js';
import { screenPorts } from './docker/screen.js';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { env } from './env.js';
import { DEFAULT_PATH, defaultHermesLookup, hermesBin, resolveHermesBin } from './hermes-bin.js';
import type { EngineInfo, EngineProvider } from './types.js';

/**
 * Every bot is run by a Hermes agent.
 *
 * - The 'primary' engine is a Hermes gateway that already runs on the computer (HERMES_URL, home
 *   HERMES_HOME_PRIMARY). It has its own life: messaging, memory, model. We only talk to its API
 *   server; we never write its config, restart it or stop it.
 * - A 'managed' engine is a Hermes home of our own under ENGINES_DIR/<botId> with its own
 *   `hermes gateway run`, started here and left running when this server exits. Its home sits
 *   *inside* the primary agent's home (ENGINES_DIR defaults to `<primary>/orbit-agents`): separate
 *   state, but still under Hermes' root, which is what lets a bot read the primary's OAuth
 *   subscription sign-ins instead of needing a copy of them.
 */

export type EngineKind = 'primary' | 'managed';
export interface Engine { kind: EngineKind; url: string; key: string; home: string }

const botRow = (botId: string) => db.prepare('SELECT * FROM bots WHERE id=?').get(botId) as any;

// ---------- small file helpers ----------

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
export function readDotenv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function readYaml(file: string): any {
  try { return YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

export function writePrivate(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** KEY=value lines for a dotenv file. */
function dotenvText(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

// ---------- identity ----------

/** Token a bot's Hermes agent presents to this server's MCP endpoint. `primary` names the primary bot. */
export function mcpToken(botId: string): string {
  return crypto.createHmac('sha256', env.sessionSecret).update(`mcp:${botId}`).digest('hex');
}

export function primaryBotId(): string | null {
  return (db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get() as any)?.id ?? null;
}

export function engineKind(botId: string): EngineKind | null {
  const e = botRow(botId)?.engine;
  return e === 'primary' || e === 'managed' ? e : null;
}

const homeFor = (botId: string) => path.join(env.enginesDir, botId);
/** A managed bot's Hermes home. Exported for the auth-sync and skills modules. */
export const managedHome = homeFor;

let cachedPrimaryKey: string | null = null;
function primaryKey(): string {
  if (env.hermesKey) return env.hermesKey;
  if (cachedPrimaryKey === null) cachedPrimaryKey = readDotenv(path.join(env.hermesHome, '.env')).API_SERVER_KEY ?? '';
  return cachedPrimaryKey;
}

// ---------- assignment ----------

function freePort(avoid: number[] = []): number {
  const used = new Set((db.prepare('SELECT engine_port FROM bots WHERE engine_port IS NOT NULL').all() as any[]).map((r) => r.engine_port as number));
  for (const p of avoid) used.add(p);
  let p = env.enginePortBase;
  while (used.has(p)) p++;
  return p;
}

/** Give a new agent bot its engine: the existing agent if nobody has it yet, otherwise one of our own. */
export function assignEngine(botId: string): EngineKind {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  if (b.engine === 'primary' || b.engine === 'managed') return b.engine;
  if (!primaryBotId()) {
    db.prepare("UPDATE bots SET engine='primary', engine_port=NULL WHERE id=?").run(botId);
    return 'primary';
  }
  db.prepare("UPDATE bots SET engine='managed', engine_port=? WHERE id=?").run(freePort(), botId);
  return 'managed';
}

// ---------- a managed bot's Hermes home ----------

/** Model credentials a managed agent may inherit from the primary agent. Never messaging tokens. */
export const SHARED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY',
  'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
  // DeepSeek is the default model for managed Bots; its key lives in the primary agent's .env.
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
];

/** Parts of the primary agent's config a managed agent starts from, so it reaches the same models. */
export const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary', 'fallback_model', 'fallback_providers', 'mcp_servers'];

function soul(b: any): string {
  const owner = (db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id) as any)?.name ?? 'the user';
  const role = b.label ? `, ${b.label}` : '';
  return [
    `You are ${b.name}${role}. You work for ${owner} as one of a small team of AI agents, each with its own screen on a shared computer.`,
    b.description ? `\n${b.description}` : '',
    '\nYou are direct, warm and brief. You do the work rather than describe it, and you say plainly what you did and what you could not do.',
    '',
  ].join('\n');
}

/** Rewrite the persona file after a rename or a new description. The primary agent keeps its own. */
export function syncPersona(botId: string) {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') return;
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));
}

function extraMcpServers(): Record<string, any> {
  if (!env.extraMcpServers) return {};
  try {
    const v = JSON.parse(env.extraMcpServers);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    console.warn('[engine] EXTRA_MCP_SERVERS is not valid JSON; ignored');
    return {};
  }
}

/** Providers whose OAuth refresh token is single-use: redeeming it rotates the pair for everyone. */
const SINGLE_USE_OAUTH = new Set(['anthropic', 'openai-codex', 'xai-oauth', 'nous']);
/** Files that hold the same single-use grants outside auth.json. */
const OAUTH_SINGLETON_FILES = ['.anthropic_oauth.json'];
/** Marks a row this server wrote from the primary's grant, so it is never mistaken for a bot's own. */
const INHERITED_SOURCE = 'inherited:orbit';

interface AuthStore {
  version?: number;
  providers?: Record<string, any>;
  credential_pool?: Record<string, any[]>;
  active_provider?: string;
  updated_at?: string;
  [key: string]: any;
}

function readAuthStore(file: string): AuthStore | null {
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    return store && typeof store === 'object' ? store : null;
  } catch {
    return null;
  }
}

const isInheritedRow = (row: any) =>
  Boolean(row && typeof row === 'object' && String(row.source ?? '') === INHERITED_SOURCE);
const tokenOf = (row: any) => String(row?.access_token ?? '').trim();
const refreshOf = (row: any) => String(row?.refresh_token ?? '').trim();

/** An access token that is present and not (about to be) expired. */
function liveToken(row: any, skewSeconds = 120): boolean {
  if (!row || typeof row !== 'object' || !tokenOf(row)) return false;
  const expMs = Number(row.expires_at_ms ?? NaN);
  if (Number.isFinite(expMs)) return expMs - skewSeconds * 1000 > Date.now();
  const expSec = Number(row.expires_at ?? NaN);
  if (Number.isFinite(expSec)) return expSec * 1000 - skewSeconds * 1000 > Date.now();
  return true;
}

/** A row this server wrote: no refresh token, so using it can never rotate the primary's grant. */
function usableInheritedRow(row: any): boolean {
  return isInheritedRow(row) && !refreshOf(row) && liveToken(row);
}

/** The subscription sign-ins the primary agent holds, one per provider, as access tokens only. */
export interface PrimarySubscription {
  provider: string;
  label: string;
  token: string;
  expiresAtMs: number | null;
  baseUrl?: string;
}

/** Providers Hermes reads a subscription token for from the environment (anthropic: ANTHROPIC_TOKEN). */
const SUBSCRIPTION_ENV: Record<string, string> = { anthropic: 'ANTHROPIC_TOKEN' };

export function primarySubscriptions(): PrimarySubscription[] {
  const store = readAuthStore(path.join(env.hermesHome, 'auth.json'));
  const pool = (store?.credential_pool ?? {}) as Record<string, any[]>;
  const out: PrimarySubscription[] = [];
  for (const provider of SINGLE_USE_OAUTH) {
    const rows = Array.isArray(pool[provider]) ? pool[provider] : [];
    const row = rows.find((r) => liveToken(r));
    if (!row) continue;
    out.push({
      provider,
      label: String(row.label ?? provider),
      token: tokenOf(row),
      expiresAtMs: Number(row.expires_at_ms ?? NaN) || null,
      ...(row.base_url ? { baseUrl: String(row.base_url) } : {}),
    });
  }
  return out;
}

/** The env vars that hand a bot those tokens (only the providers Hermes reads from the environment). */
export function subscriptionEnv(subs: PrimarySubscription[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const sub of subs) {
    const name = SUBSCRIPTION_ENV[sub.provider];
    if (name) vars[name] = sub.token;
  }
  return vars;
}

/**
 * Hand a managed bot the primary agent's subscription sign-ins, without copying the grant.
 *
 * Hermes treats an OAuth refresh token as single-use: redeeming it rotates the pair and strands
 * every other holder with `invalid_grant` — which is exactly the "No Anthropic credentials found"
 * a bot shows after inheriting one by copy. So the bot gets the primary's *access token only*, in
 * its `.env` as ANTHROPIC_TOKEN / as a pool row with no refresh token. Neither can rotate anything
 * the user signed in with, and `startSubscriptionSync` re-reads them as the primary refreshes.
 *
 * A bot that signed in for itself keeps its own rows: only rows this server wrote (`source:
 * inherited:orbit`) are replaced, and rows that are provably a fork of the primary's grant are
 * dropped. Returns what it changed, for logging and tests.
 */
export function inheritSubscriptions(home: string): string[] {
  const subs = primarySubscriptions();
  const ownFile = path.join(home, 'auth.json');
  const own: AuthStore = readAuthStore(ownFile) ?? { version: 1, providers: {} };
  own.credential_pool = own.credential_pool && typeof own.credential_pool === 'object' ? own.credential_pool : {};
  if (!own.providers || typeof own.providers !== 'object') own.providers = {};
  const changed: string[] = [];

  for (const provider of SINGLE_USE_OAUTH) {
    const mine: any[] = Array.isArray(own.credential_pool[provider]) ? own.credential_pool[provider] : [];
    const sub = subs.find((x) => x.provider === provider) ?? null;

    // A fork carries the primary's refresh token; using it could rotate the user's sign-in away.
    const forked = mine.filter(
      (r) => !isInheritedRow(r) && refreshOf(r) && (!sub || tokenOf(r) !== sub.token),
    );
    const kept = mine.filter((r) => !forked.includes(r));
    let dirty = forked.length > 0;
    if (forked.length) changed.push(`-fork:${provider}`);

    // A bot's own sign-in wins over anything inherited.
    if (kept.some((r) => !isInheritedRow(r))) {
      if (dirty) own.credential_pool[provider] = kept;
      continue;
    }
    if (!sub) {
      if (kept.length) { delete own.credential_pool[provider]; changed.push(`-expired:${provider}`); }
      continue;
    }
    const row: Record<string, any> = {
      id: kept[0]?.id ?? crypto.randomBytes(3).toString('hex'),
      label: `inherited:${sub.label}`,
      auth_type: 'oauth',
      source: INHERITED_SOURCE,
      priority: 0,
      access_token: sub.token,
      request_count: 0,
    };
    if (sub.expiresAtMs) row.expires_at_ms = sub.expiresAtMs;
    if (sub.baseUrl) row.base_url = sub.baseUrl;
    if (JSON.stringify(kept) === JSON.stringify([row])) continue;
    own.credential_pool[provider] = [row];
    changed.push(provider);
  }

  // Singleton credential files carry the same single-use grants; a copy re-seeds a forked row.
  for (const name of OAUTH_SINGLETON_FILES) {
    const file = path.join(home, name);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    changed.push(`-${name}`);
  }

  if (changed.length) {
    own.updated_at = new Date().toISOString();
    writePrivate(ownFile, `${JSON.stringify(own, null, 2)}\n`);
  }
  return changed;
}

/**
 * Keep every managed bot's inherited credentials fresh.
 *
 * Hermes reads a pool row when it needs one and re-reads auth.json when the file changes, so
 * rewriting a row is enough. A token passed through the environment is read once at gateway start,
 * so when that one changes the bot's engine is restarted — which happens when the primary agent
 * refreshes (roughly every eight hours), not on every pass.
 */
export function startSubscriptionSync(intervalMs = 5 * 60_000): NodeJS.Timeout {
  const run = async () => {
    const subs = primarySubscriptions();
    const envVars = subscriptionEnv(subs);
    let bots: any[] = [];
    try {
      bots = db.prepare("SELECT id FROM bots WHERE engine='managed'").all() as any[];
    } catch {
      return;
    }
    for (const b of bots) {
      try {
        const home = homeFor(b.id);
        if (!fs.existsSync(home)) continue;
        inheritSubscriptions(home);
        const envFile = path.join(home, '.env');
        const vars = readDotenv(envFile);
        let changed = false;
        for (const [name, value] of Object.entries(envVars)) {
          // A bot with its own key keeps it: the user set it for this bot.
          if (vars[`${name}_OWN`]) continue;
          if (vars[name] === value) continue;
          vars[name] = value;
          changed = true;
        }
        if (!changed) continue;
        writePrivate(envFile, dotenvText(vars));
        await restartEngine(b.id).catch((e: any) => console.warn(`[engine] restart after subscription sync ${b.id} failed: ${e?.message ?? e}`));
        console.log(`[engine] subscription sync ${b.id}: restarted with a refreshed token`);
      } catch (e: any) {
        console.warn(`[engine] subscription sync ${b.id} failed: ${e?.message ?? e}`);
      }
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return timer;
}

/** A loopback model endpoint on the host is not the container's loopback. */
function inContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * Repoint loopback model endpoints at the machine the primary agent runs on.
 *
 * A local server (LM Studio on :1234, ollama, a custom endpoint) is copied from the primary's
 * config as `http://localhost:1234/v1`. Inside the stack container that address is the container
 * itself, where nothing listens — the bot then fails to reach a model that works for the primary.
 * `host.docker.internal` is that same port on the host.
 */
export function adaptLocalEndpoints<T>(cfg: T): T {
  if (!inContainer() || !cfg || typeof cfg !== 'object') return cfg;
  const fix = (value: unknown) =>
    typeof value === 'string'
      ? value.replace(/\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i, '//host.docker.internal')
      : value;
  for (const key of ['providers', 'custom_providers'] as const) {
    const block = (cfg as any)[key];
    if (!block || typeof block !== 'object') continue;
    for (const entry of Object.values<any>(block)) {
      if (!entry || typeof entry !== 'object') continue;
      if ('base_url' in entry) entry.base_url = fix(entry.base_url);
      if ('api_base' in entry) entry.api_base = fix(entry.api_base);
    }
  }
  return cfg;
}

/** Create or refresh the home. config.yaml is created once; after that only the keys we own are patched. */
async function writeHome(botId: string): Promise<{ home: string; key: string; display: string | null }> {
  const b = botRow(botId);
  const home = homeFor(botId);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'locks'), { recursive: true });
  fs.chmodSync(home, 0o700);

  // Its screen decides which display and which Chrome it drives. Only meaningful on the computer itself.
  let display: string | null = null;
  let cdp = '';
  if (computerKindFor(botId) === 'docker') {
    // A container's browser answers DevTools inside the container; the display it draws on is in
    // there too, so the agent drives the browser over CDP and gets no local DISPLAY. Ask the
    // provider for the address, because it depends on where *this server* runs: a host server dials
    // a published loopback port, a containerized one dials the bot's address on the shared Docker
    // network. Assuming 127.0.0.1 here is what made containerized bots' browsers unreachable.
    try {
      const s = claimScreen(botId, env.computerMaxDisplays, randomUUID);
      cdp = await providerFor(botId)
        .cdpUrl(botId, s.screen_id)
        .catch(() => `http://127.0.0.1:${screenPorts(s.display_index).cdpPort}`);
    } catch (e: any) {
      console.warn(`[engine] no display for ${b.name} yet: ${e?.message ?? e}`);
    }
  } else if (env.localBox) {
    try {
      const s = await screenFor(b.user_id, botId);
      display = displayFor(s.screenId);
      cdp = cdpUrlFor(botId, s.screenId);
    } catch (e: any) {
      console.warn(`[engine] no screen for ${b.name} yet: ${e?.message ?? e}`);
    }
  }

  const cwd = env.localBox ? path.join(env.botDataDir, 'files', botId) : path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });

  const cfgFile = path.join(home, 'config.yaml');
  const fresh = !fs.existsSync(cfgFile);
  const cfg = fresh ? {} : readYaml(cfgFile);
  if (fresh) {
    const primary = readYaml(path.join(env.hermesHome, 'config.yaml'));
    for (const k of SHARED_CONFIG) if (primary[k] !== undefined) cfg[k] = primary[k];
    cfg.agent = { reasoning_effort: 'medium' };
  }
  // A model endpoint on the host's loopback (LM Studio, ollama, a custom server) has to be addressed
  // through the host when this server runs in a container.
  adaptLocalEndpoints(cfg);
  cfg.platform_toolsets = { ...(cfg.platform_toolsets ?? {}), api_server: ['hermes-api-server', ...(display ? ['computer_use'] : [])] };
  cfg.terminal = { ...(cfg.terminal ?? {}), cwd };
  if (cdp) cfg.browser = { ...(cfg.browser ?? {}), cdp_url: cdp };
  cfg.mcp_servers = {
    ...(cfg.mcp_servers ?? {}),
    ...extraMcpServers(),
    hq: { url: managedMcpUrl(botId), headers: { Authorization: `Bearer ${mcpToken(botId)}` }, timeout: 1800, connect_timeout: 30 },
  };
  writePrivate(cfgFile, YAML.stringify(cfg));

  if (!fs.existsSync(path.join(home, 'SOUL.md'))) fs.writeFileSync(path.join(home, 'SOUL.md'), soul(b));

  // Subscription sign-ins: the bot gets the primary's access token, never its refresh token, so the
  // user's own sign-in can never be rotated away by a bot. See inheritSubscriptions().
  inheritSubscriptions(home);

  // .env is ours entirely: the API server plus inherited model keys. Keys the user added by hand are kept.
  const envFile = path.join(home, '.env');
  const mine = readDotenv(envFile);
  const key = mine.API_SERVER_KEY || crypto.randomBytes(24).toString('hex');
  const primaryEnv = readDotenv(path.join(env.hermesHome, '.env'));
  const vars: Record<string, string> = { ...mine };
  // The primary's value always wins: a key the user rotated there must reach every managed bot.
  for (const k of SHARED_ENV) {
    const v = primaryEnv[k] ?? process.env[k];
    if (v) vars[k] = v;
  }
  // Subscription sign-ins travel as access tokens in the environment (never a copy of the grant).
  for (const [name, value] of Object.entries(subscriptionEnv(primarySubscriptions()))) {
    const own = mine[name] && vars[name] === mine[name];
    if (own) vars[`${name}_OWN`] ??= '1'; // the user put this bot's own key there; keep it
    if (!own) vars[name] = value;
  }
  Object.assign(vars, { API_SERVER_ENABLED: 'true', API_SERVER_KEY: key, API_SERVER_PORT: String(b.engine_port), API_SERVER_HOST: '127.0.0.1' });
  if (cdp) vars.BROWSER_CDP_URL = cdp; else delete vars.BROWSER_CDP_URL;
  writePrivate(envFile, dotenvText(vars));

  // Credentials and config keys the home was missing (an existing home keeps its own choices).
  syncManagedAuth(botId);

  return { home, key, display };
}

// ---------- keeping managed credentials in line with the primary ----------

/**
 * Bring a managed bot's .env and config.yaml up to date with the primary agent's credentials.
 *
 * - `.env`: every SHARED_ENV key the primary has a value for is overwritten, so a rotated key reaches
 *   the bot. A key the primary lacks is left as the bot had it (the user may have set it by hand).
 * - `config.yaml`: a SHARED_CONFIG key is copied only when the bot's config has never had it. An
 *   existing value is the bot's own choice (it may deliberately run a different model) and is kept —
 *   except a placeholder model (the settings panel writes the literal `Default` when none is picked),
 *   which is not a choice and must not shadow the primary's model forever.
 *
 * Safe to call at any time; returns the keys it wrote, for logging and tests.
 */
export function syncManagedAuth(botId: string): string[] {
  if (engineKind(botId) !== 'managed') return [];
  const home = managedHome(botId);
  const synced: string[] = [];
  // A home written by an older build still holds a forked copy of the primary's grant; this replaces
  // it with the access token the bot may actually use, and refreshes one that has gone stale.
  for (const key of inheritSubscriptions(home)) synced.push(key);

  const primaryEnv = readDotenv(path.join(env.hermesHome, '.env'));
  if (!SHARED_ENV.some((k) => (primaryEnv[k] ?? '').trim())) warnNoPrimaryCredentials();
  const envFile = path.join(home, '.env');
  const vars = readDotenv(envFile);
  const envSynced: string[] = [];
  for (const k of SHARED_ENV) {
    // The stack's own environment counts too: it is where a containerized server keeps its .env.
    const v = (primaryEnv[k] ?? process.env[k] ?? '').trim();
    if (!v) continue; // nothing to share: keep whatever this bot has
    if (vars[k] === v) continue;
    vars[k] = v;
    envSynced.push(k);
  }
  // Subscription sign-ins as environment tokens (see inheritSubscriptions): refreshed whenever the
  // primary agent refreshes its own, so a bot never runs on a token the user's sign-in outgrew.
  for (const [name, value] of Object.entries(subscriptionEnv(primarySubscriptions()))) {
    if (vars[`${name}_OWN`] || vars[name] === value) continue;
    vars[name] = value;
    envSynced.push(name);
  }
  if (envSynced.length) {
    writePrivate(envFile, dotenvText(vars));
    synced.push(...envSynced);
  }

  const primaryCfg = readYaml(path.join(env.hermesHome, 'config.yaml'));
  const cfgFile = path.join(home, 'config.yaml');
  const cfg = readYaml(cfgFile);
  const cfgSynced: string[] = [];
  for (const k of SHARED_CONFIG) {
    if (primaryCfg[k] === undefined || primaryCfg[k] === null) continue;
    if (k === 'model' && isPlaceholderModel(cfg.model)) {
      cfg.model = primaryCfg.model;
      cfgSynced.push(k);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(cfg, k)) continue; // the bot already has its own
    cfg[k] = primaryCfg[k];
    cfgSynced.push(k);
  }
  if (cfgSynced.length) writePrivate(cfgFile, YAML.stringify(cfg));
  synced.push(...cfgSynced);
  // Existing homes copied `providers` before endpoints were adapted; fix them in place so a local
  // model server on the host is reachable from this container.
  if (inContainer()) {
    const before = JSON.stringify(cfg.providers ?? null) + JSON.stringify(cfg.custom_providers ?? null);
    adaptLocalEndpoints(cfg);
    if (JSON.stringify(cfg.providers ?? null) + JSON.stringify(cfg.custom_providers ?? null) !== before) {
      writePrivate(cfgFile, YAML.stringify(cfg));
      synced.push('providers.base_url');
    }
  }

  // The roster row names the model every turn asks for. The settings panel used to save the word
  // `Default` there, which pins a model id no provider knows; repair it from the config that is now
  // right, so the panel stops showing a placeholder and the turn stops sending one.
  const row = botRow(botId);
  const storedModel = typeof row?.model === 'string' ? row.model.trim() : '';
  // Only a stored word is repaired: no model stored at all is a legitimate "use the engine default".
  if (storedModel && storedModel.toLowerCase() === 'default') {
    const block = cfg.model;
    const name = typeof block === 'string' ? block : (block as any)?.default;
    if (typeof name === 'string' && name.trim() && !isPlaceholderModel(name)) {
      db.prepare('UPDATE bots SET model=?, updated_at=? WHERE id=?').run(name.trim(), Date.now(), botId);
      const provider = (block as any)?.provider;
      if (typeof provider === 'string' && provider.trim()) db.prepare('UPDATE bots SET provider=? WHERE id=?').run(provider.trim(), botId);
      synced.push('bots.model');
    }
  }

  for (const k of synced) console.log(`[engine] auth sync ${botId}: ${k}`);
  return synced;
}

/** `Default`, `default` and an empty block are what "no model chosen" looks like on disk. */
function isPlaceholderModel(model: unknown): boolean {
  const placeholder = (v: unknown) => typeof v === 'string' && /^(?:|default)$/i.test(v.trim());
  if (model === undefined || model === null) return true;
  if (typeof model === 'string') return placeholder(model);
  if (typeof model !== 'object' || Array.isArray(model)) return false;
  const block = model as Record<string, unknown>;
  // A model block with a provider and no `default` is a deliberate choice (the provider's own
  // default model), not a placeholder.
  if (!Object.prototype.hasOwnProperty.call(block, 'default')) return Object.keys(block).length === 0;
  return placeholder(block.default);
}

let warnedNoPrimary = false;

/**
 * Say once, clearly, that the primary agent's credentials could not be read. Without this the only
 * symptom is a new bot answering "Hermes is not connected to any AI provider yet", which points at
 * the bot rather than at the missing primary home.
 */
function warnNoPrimaryCredentials() {
  if (warnedNoPrimary) return;
  warnedNoPrimary = true;
  console.warn(
    `[engine] no model credentials in ${path.join(env.hermesHome, '.env')}: new agents will start without ` +
      `an API key. In the desktop app this home is the host's Hermes home, mounted into the stack; ` +
      `outside it, set HERMES_HOME_PRIMARY to the directory holding the primary agent's .env.`,
  );
}

/** The same pass over every managed bot. Returns how many bots had something brought in line. */
export async function syncAllManagedAuth({ restart = false }: { restart?: boolean } = {}): Promise<number> {
  const bots = db.prepare("SELECT id FROM bots WHERE engine='managed'").all() as any[];
  let synced = 0;
  for (const b of bots) {
    try {
      const written = syncManagedAuth(b.id);
      if (!written.length) continue;
      synced++;
      // A gateway reads its .env when it starts, so a key that arrived afterwards only takes effect
      // on the next start. Restarting is opt-in: at boot the gateway is being started right now.
      if (restart) {
        void restartEngine(b.id).catch((e: any) => console.warn(`[engine] restart after auth sync ${b.id} failed: ${e?.message ?? e}`));
      }
    } catch (e: any) {
      console.warn(`[engine] auth sync ${b.id} failed: ${e?.message ?? e}`);
    }
  }
  return synced;
}

// ---------- a managed bot's gateway ----------

async function healthy(url: string, timeoutMs = 2500): Promise<any | null> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function keyAccepted(url: string, key: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/** The gateway's pid, but only if the pid file belongs to this home and the process is alive. */
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

async function stopGateway(botId: string) {
  const home = homeFor(botId);
  const pid = gatewayPid(home);
  if (!pid) return;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } }
  };
  signal('SIGTERM');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { process.kill(pid, 0); } catch { return; }
  }
  signal('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
}

const starting = new Map<string, Promise<void>>();
const failures = new Map<string, string>();
const keys = new Map<string, string>();

function managedUrl(botId: string): string {
  return `http://127.0.0.1:${botRow(botId).engine_port}`;
}

/**
 * Where a managed gateway reaches this server's MCP endpoint. We start that gateway ourselves, so it
 * runs on this machine and loopback is the shortest path to us. MCP_BASE_URL describes the other
 * case — a gateway on another machine, like the host's primary agent — and inside Docker its
 * host.docker.internal address only reaches us while the published port happens to be 8787.
 */
function managedMcpUrl(botId: string): string {
  return `http://127.0.0.1:${env.port}/mcp/${botId}`;
}

function managedKey(botId: string): string {
  let k = keys.get(botId);
  if (!k) {
    k = readDotenv(path.join(homeFor(botId), '.env')).API_SERVER_KEY ?? '';
    if (k) keys.set(botId, k);
  }
  return k;
}

async function startGateway(botId: string, attempt = 0): Promise<void> {
  const b = botRow(botId);
  if (!b || b.engine !== 'managed') throw new Error('not a managed engine');
  if (!b.engine_port) db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(freePort(), botId);
  const url = managedUrl(botId);

  // A gateway from an earlier run of this server is still good: use it as it is.
  if ((await healthy(url)) && managedKey(botId) && (await keyAccepted(url, managedKey(botId)))) return;
  if (await healthy(url)) {
    if (gatewayPid(homeFor(botId))) await stopGateway(botId);
    else if (attempt < 10) {
      // Something we do not manage holds this port (a gateway from a Bot that no longer exists, or
      // one still shutting down). Walk forward: ten attempts covers a burst of stale engines, and
      // giving up after three left a brand new Bot answering "port is taken by something else".
      const taken = Number(botRow(botId).engine_port);
      db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run(freePort([taken]), botId);
      return startGateway(botId, attempt + 1);
    } else throw new Error(`Port ${botRow(botId).engine_port} is taken by something else.`);
  }

  const { home, key, display } = await writeHome(botId);
  keys.set(botId, key);
  if (gatewayPid(home)) await stopGateway(botId);

  // Resolved before anything is spawned: when Hermes is not installed, this throws the message that
  // the bot's settings panel shows, instead of leaving a bare `spawn hermes ENOENT` in the log.
  const bin = hermesBin(defaultHermesLookup({ configured: env.hermesBinConfigured }));

  const log = fs.openSync(path.join(home, 'logs', 'gateway.out.log'), 'a');
  const child = spawn(bin, ['gateway', 'run', '--no-supervise'], {
    cwd: home,
    detached: true,
    stdio: ['ignore', log, log],
    // Only what the agent needs. None of this server's secrets, and nothing of the primary agent's messaging.
    env: {
      // The CLI's own directory first, so a `hermes` that shells out to itself or its venv tools
      // resolves even when the image's PATH (or a launchd PATH) does not contain it.
      PATH: [path.dirname(bin), process.env.PATH ?? DEFAULT_PATH].filter(Boolean).join(path.delimiter),
      HOME: process.env.HOME ?? '/root',
      USER: process.env.USER ?? 'root',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HERMES_HOME: home,
      HERMES_GATEWAY_LOCK_DIR: path.join(home, 'locks'),
      // Hermes' browser tool talks to a helper process it finds under this folder. With the default
      // (one folder per HOME) every agent on the computer would end up driving the same browser.
      BH_HOME: path.join(home, 'browser-harness'),
      // The stack's api container runs as root so it can open the mounted Docker socket, and the
      // bundled gateway refuses root unless this opt-in is forwarded to it. It is deliberately the
      // only Hermes variable passed through: everything else here is chosen per bot.
      ...(process.env.HERMES_ALLOW_ROOT_GATEWAY
        ? { HERMES_ALLOW_ROOT_GATEWAY: process.env.HERMES_ALLOW_ROOT_GATEWAY }
        : {}),
      ...(display ? { DISPLAY: display } : {}),
    },
  });
  fs.closeSync(log);
  let exited: string | null = null;
  child.once('error', (e: any) => {
    exited =
      e?.code === 'ENOENT'
        // Resolved, then vanished between the check and the spawn (image swap, uninstall). Rare, but
        // say what to fix rather than echoing "ENOENT".
        ? `could not run ${bin}: the file is no longer executable or has gone. ` +
          `Set HERMES_BIN to the hermes executable (currently ${env.hermesBinConfigured || `"hermes" on PATH`}).`
        : `could not run ${bin}: ${e?.message ?? e}`;
  });
  child.once('exit', (code) => { exited = `the agent stopped while starting (exit ${code}). See ${path.join(home, 'logs', 'gateway.out.log')}`; });
  child.unref();

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) throw new Error(exited);
    if (await healthy(url, 1500)) {
      console.log(`[engine] ${b.name}: gateway up on ${url}`);
      return;
    }
  }
  throw new Error(`The agent did not come up within 90 seconds. See ${path.join(home, 'logs', 'gateway.out.log')}`);
}

/** Start (or adopt) the bot's gateway. Safe to call often; concurrent calls share one start. */
function ensureManaged(botId: string): Promise<void> {
  let p = starting.get(botId);
  if (!p) {
    p = startGateway(botId)
      .then(() => { failures.delete(botId); })
      .catch((e: any) => {
        const msg = String(e?.message ?? e);
        failures.set(botId, msg);
        console.warn(`[engine] ${botId}: ${msg}`);
        throw e;
      })
      .finally(() => starting.delete(botId));
    starting.set(botId, p);
  }
  return p;
}

/** Where to send this bot's turns. Starts its gateway if it is not running. */
export async function engineFor(botId: string): Promise<Engine> {
  let kind = engineKind(botId);
  if (!kind) {
    const b = botRow(botId);
    if (!b) throw new Error('bot not found');
    if (b.kind === 'room') throw new Error('A group chat has no agent of its own.');
    kind = assignEngine(botId);
  }
  if (kind === 'primary') return { kind, url: env.hermesUrl, key: primaryKey(), home: env.hermesHome };
  const url = managedUrl(botId);
  if (!(await healthy(url, 1500)) || !managedKey(botId)) await ensureManaged(botId);
  return { kind, url, key: managedKey(botId), home: homeFor(botId) };
}

/** The bot's Hermes home, without starting anything (memory files, sign-in commands). */
export function engineHome(botId: string): string | null {
  const kind = engineKind(botId);
  return kind === 'primary' ? env.hermesHome : kind === 'managed' ? homeFor(botId) : null;
}

/**
 * Hermes can run a private screen of its own for a profile (its "Bot Desktop": an Xvnc display with
 * state in <home>/bot-desktop). While that screen is up, the agent's computer-use tool acts there and
 * not on the screen this app shows (so does its browser tool, unless the config pins it to a Chrome
 * with `browser.cdp_url`), so the user could be watching an idle desktop.
 */
export function ownScreenOn(botId: string): boolean {
  const home = engineHome(botId);
  if (!home) return false;
  const dir = path.join(home, 'bot-desktop');
  try {
    // launcher.pid holds "<pid> <create time>"; the env file appears once the screen is usable.
    const pid = Number(fs.readFileSync(path.join(dir, 'launcher.pid'), 'utf8').trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 1 || !fs.existsSync(path.join(dir, 'env'))) return false;
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/** Ask Hermes to stop that private screen. Hermes refuses while a person is using it; the refusal is passed on. */
export function stopOwnScreen(botId: string): Promise<void> {
  const home = engineHome(botId);
  if (!home) return Promise.reject(new Error('This bot has no agent.'));
  let bin: string;
  try {
    bin = hermesBin(defaultHermesLookup({ configured: env.hermesBinConfigured }));
  } catch (e: any) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    execFile(bin, ['computer-use', 'screen', 'stop'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!ownScreenOn(botId)) return resolve();
      const said = `${stderr || ''}\n${stdout || ''}`.trim().split('\n').filter(Boolean).pop();
      reject(new Error(said || (err ? String(err.message) : 'The screen is still running.')));
    });
  });
}

/** Start the gateway in the background (after creating a bot, or on server start). */
export function provisionEngine(botId: string) {
  if (engineKind(botId) === 'managed') ensureManaged(botId).catch(() => {});
}

export async function restartEngine(botId: string): Promise<void> {
  if (engineKind(botId) !== 'managed') return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  optionsCache.delete(botId);
  provisionEngine(botId);
}

/** The bot is gone: stop its gateway and delete its home. The primary agent is left alone. */
export async function removeEngine(botId: string): Promise<void> {
  const home = homeFor(botId);
  if (!fs.existsSync(home)) return;
  await starting.get(botId)?.catch(() => {});
  await stopGateway(botId);
  keys.delete(botId);
  failures.delete(botId);
  optionsCache.delete(botId);
  if (path.resolve(home).startsWith(path.resolve(env.enginesDir) + path.sep)) fs.rmSync(home, { recursive: true, force: true });
}

/** On server start: give older bots an engine, then bring the managed gateways up. */
/** Inject the hq MCP server entry into the primary Hermes config so it can reach the app's tools. */
function syncPrimaryHqConfig(botId: string) {
  const cfgFile = path.join(env.hermesHome, 'config.yaml');
  if (!fs.existsSync(cfgFile)) return;
  const cfg = readYaml(cfgFile);
  const hqUrl = `${env.mcpBaseUrl}/mcp/${botId}`;
  if (cfg.mcp_servers?.hq?.url === hqUrl) return; // already up-to-date
  cfg.mcp_servers = {
    ...(cfg.mcp_servers ?? {}),
    hq: { url: hqUrl, headers: { Authorization: `Bearer ${mcpToken(botId)}` }, timeout: 1800, connect_timeout: 30 },
  };
  fs.writeFileSync(cfgFile, YAML.stringify(cfg), 'utf8');
}

export function initEngines() {
  fs.mkdirSync(env.enginesDir, { recursive: true });
  // Say where the CLI came from (or what is missing) once, at boot: the first place to look when a
  // managed bot will not start.
  const resolution = resolveHermesBin(defaultHermesLookup({ configured: env.hermesBinConfigured }));
  if (resolution.found) console.log(`[engine] hermes: ${resolution.path} (${resolution.via})`);
  else console.warn(`[engine] ${resolution.message}`);
  const bots = db.prepare("SELECT id, is_primary FROM bots WHERE engine IS NULL AND COALESCE(kind,'agent') <> 'room' AND COALESCE(hidden,0)=0 ORDER BY is_primary DESC, created_at ASC").all() as any[];
  for (const b of bots) assignEngine(b.id);
  const primaryBot = db.prepare("SELECT id FROM bots WHERE engine='primary' LIMIT 1").get() as any;
  if (primaryBot) syncPrimaryHqConfig(primaryBot.id);
  for (const b of db.prepare("SELECT id FROM bots WHERE engine='managed'").all() as any[]) provisionEngine(b.id);
}

// ---------- what the settings panel shows ----------

/** Providers worth showing even when not signed in. */
const WELL_KNOWN = ['anthropic', 'openai-codex', 'xai-oauth', 'xai', 'openrouter', 'nous', 'gemini', 'openai-api'];

const optionsCache = new Map<string, { at: number; data: any }>();

async function modelOptions(botId: string, e: { url: string; key: string }): Promise<any | null> {
  const hit = optionsCache.get(botId);
  if (hit && Date.now() - hit.at < 15_000) return hit.data;
  try {
    const r = await fetch(`${e.url}/api/model/options`, { headers: e.key ? { Authorization: `Bearer ${e.key}` } : {}, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const data = await r.json();
    optionsCache.set(botId, { at: Date.now(), data });
    return data;
  } catch { return null; }
}

function toProviders(data: any): EngineProvider[] {
  const list: any[] = Array.isArray(data?.providers) ? data.providers : [];
  const out = list
    .filter((p) => p?.slug && (p.authenticated || WELL_KNOWN.includes(p.slug)))
    .map((p): EngineProvider => {
      const featured = Array.isArray(p.featured_models) && p.featured_models.length ? p.featured_models : Array.isArray(p.models) ? p.models : [];
      return {
        id: String(p.slug),
        name: p.slug === 'anthropic' ? 'Claude (Anthropic)' : String(p.name ?? p.slug),
        // Hermes lists Anthropic as an API-key provider, yet it can also sign in to a Claude subscription. Offer that until a key is in place.
        kind: String(p.auth_type ?? '').includes('oauth') || (p.slug === 'anthropic' && !p.authenticated) ? 'subscription' : 'api_key',
        connected: !!p.authenticated,
        models: featured.filter((m: unknown) => typeof m === 'string').slice(0, 12),
      };
    });
  const rank = (p: EngineProvider) => (p.connected ? 0 : 1) * 100 + (WELL_KNOWN.indexOf(p.id) < 0 ? 50 : WELL_KNOWN.indexOf(p.id));
  return out.sort((a, b) => rank(a) - rank(b));
}

export async function engineInfo(botId: string): Promise<EngineInfo> {
  const b = botRow(botId);
  if (!b) throw new Error('bot not found');
  const kind = engineKind(botId);
  const base: EngineInfo = { botId, profile: kind === 'primary' ? 'default' : botId, status: 'stopped', error: null, model: b.model ?? null, provider: b.provider ?? null, version: null, providers: [], ownScreen: kind ? ownScreenOn(botId) : false };
  if (!kind) return { ...base, status: 'error', error: 'This bot has no agent.' };

  let e: { url: string; key: string };
  if (kind === 'primary') e = { url: env.hermesUrl, key: primaryKey() };
  else {
    if (!b.engine_port) return { ...base, status: 'error', error: 'No port assigned.' };
    e = { url: managedUrl(botId), key: managedKey(botId) };
  }

  const health = await healthy(e.url);
  if (!health) {
    if (kind === 'primary') return { ...base, status: 'error', error: `The agent at ${env.hermesUrl} is not answering.` };
    if (starting.has(botId)) return { ...base, status: 'starting' };
    const failed = failures.get(botId);
    if (failed) return { ...base, status: 'error', error: failed };
    provisionEngine(botId);
    return { ...base, status: 'starting' };
  }
  if (kind === 'managed' && starting.has(botId)) return { ...base, status: 'starting' };

  const data = await modelOptions(botId, e);
  return {
    ...base,
    status: 'ready',
    version: typeof health.version === 'string' && health.version !== 'unknown' ? health.version : null,
    model: b.model ?? data?.model ?? null,
    provider: b.provider ?? data?.provider ?? null,
    providers: toProviders(data),
  };
}

/** After a sign-in the provider list changes; drop what we remembered. */
export function forgetEngineOptions(botId: string) { optionsCache.delete(botId); }

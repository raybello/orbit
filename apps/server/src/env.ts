import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/** A secret from NAME, or from the file named by NAME_FILE (so keys need not sit in .env). */
function secret(name: string): string {
  const direct = process.env[name];
  if (direct) return direct;
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  throw new Error(`Missing env ${name} (or ${name}_FILE)`);
}

const hermesHome = process.env.HERMES_HOME_PRIMARY ?? path.join(os.homedir(), '.hermes');

/** Hosts a container uses to name another container; the host itself cannot resolve them. */
const CONTAINER_ONLY_HOSTS = new Set(['host.docker.internal', 'orbit-api', 'gateway.docker.internal']);

/**
 * Where the primary (host-run) agent should reach this server's MCP endpoint.
 *
 * MCP_BASE_URL exists for gateways inside containers. The primary agent is the user's own Hermes on
 * the host: writing that container-facing name into its config makes every app tool silently
 * unavailable, which is what an agent reports as "send_to_bot isn't in my toolset". APP_URL is the
 * published address the host can actually dial, so a container-only MCP base falls back to it.
 */
function primaryMcpBase(mcpBase: string | undefined, override: string | undefined, appUrl: string | undefined, port: string | undefined): string {
  const explicit = (override ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const mcp = (mcpBase ?? `http://127.0.0.1:${port ?? 8787}`).replace(/\/+$/, '');
  try {
    if (CONTAINER_ONLY_HOSTS.has(new URL(mcp).hostname)) return new URL((appUrl ?? '').trim() || mcp).origin;
  } catch {
    /* an unparseable base is left as given; the boot log warns about it */
  }
  return mcp;
}


/** Our own version, read from package.json at startup. dist/env.js sits one level under the package
 * root, so the same relative path works for source and build. */
function packageVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  xaiKey: process.env.XAI_API_KEY ?? '',
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  /** `https://us.api.x.ai/v1` keeps inference in the US. Managed bots receive the raw variable (engine.ts SHARED_ENV). */
  xaiBaseUrl: (process.env.XAI_BASE_URL?.trim() || 'https://api.x.ai/v1').replace(/\/+$/, ''),
  composioKey: process.env.COMPOSIO_API_KEY ?? '',
  orgoKey: process.env.ORGO_API_KEY ?? (process.env.ORGO_API_KEY_FILE ? fs.readFileSync(process.env.ORGO_API_KEY_FILE, 'utf8').trim() : ''),
  sessionSecret: req('SESSION_SECRET'),
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? new URL('../../../data/grokbot.db', import.meta.url).pathname,
  /** Local directory for bot files and Chrome profiles. Replaces /root/grokbot on non-root dev machines. */
  botDataDir: process.env.BOT_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'bot-hq'),
  /**
   * Model cache for the on-device STT/TTS/VAD engines (layout in docs/voice-local-conventions.md).
   * Tests and the desktop app point VOICE_MODELS_DIR at a prepopulated cache.
   */
  voiceModelsDir: process.env.VOICE_MODELS_DIR ?? path.join(process.env.DATA_DIR ?? './data', 'voice-models'),

  // ---- Hermes engine ----
  /** The `hermes` CLI used to start a gateway for each extra bot. */
  hermesBin: process.env.HERMES_BIN ?? 'hermes',
  /**
   * HERMES_BIN exactly as given, '' when unset. engine.ts resolves this to a real executable with
   * hermes-bin.ts; the field above stays as the display default other callers quote into a shell.
   */
  hermesBinConfigured: (process.env.HERMES_BIN ?? '').trim(),
  /** The primary bot's Hermes home and API server (an agent that already runs; never restarted by us). */
  hermesHome,
  hermesUrl: (process.env.HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/+$/, ''),
  hermesKey: process.env.HERMES_KEY ?? '',
  /** Where each extra bot's own Hermes home lives. Must be outside ~/.hermes so it is a separate tenant. */
  enginesDir: process.env.ENGINES_DIR ?? new URL('../../../data/engines', import.meta.url).pathname,
  enginePortBase: Number(process.env.ENGINE_PORT_BASE ?? 8650),
  /** URL the Hermes gateways use to reach this server's MCP endpoint. */
  mcpBaseUrl: (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/+$/, ''),
  /**
   * The MCP base the *primary* agent uses. That agent runs on the host, not inside the stack, so the
   * container-facing MCP_BASE_URL (host.docker.internal:8787) is both unresolvable for it and on the
   * wrong port; APP_URL is the address the host actually published. PRIMARY_MCP_BASE_URL wins when
   * somebody fronts the app with a proxy.
   */
  primaryMcpBaseUrl: primaryMcpBase(process.env.MCP_BASE_URL, process.env.PRIMARY_MCP_BASE_URL, process.env.APP_URL, process.env.PORT),
  /** Extra MCP servers every managed bot gets, as a JSON object of Hermes `mcp_servers` entries (e.g. X's XMCP). */
  extraMcpServers: process.env.EXTRA_MCP_SERVERS ?? '',
  primaryBotName: process.env.PRIMARY_BOT_NAME ?? 'Atlas',
  primaryBotLabel: process.env.PRIMARY_BOT_LABEL ?? 'Chief of Staff',

  // ---- the one shared computer ----
  /** The Orgo computer every bot works on (one screen each). Empty = legacy one-box-per-user mode is not supported. */
  orgoComputerId: process.env.ORGO_COMPUTER_ID ?? '',
  /** This server runs on that computer, so shell commands run locally instead of through Orgo's API. */
  localBox: process.env.HQ_LOCAL === '1',
  /**
   * DevTools URL of a Chrome that already runs on the default screen and belongs to the primary bot
   * (e.g. http://127.0.0.1:9333). When set, we never start or stop that screen's Chrome ourselves.
   */
  primaryCdpUrl: process.env.PRIMARY_CDP_URL ?? '',
  /** Bots that can each have a screen (Orgo allows four screens on one Linux computer). */
  maxBots: Number(process.env.MAX_BOTS ?? 4),

  // ---- desktop app / local stack ----
  /**
   * Shared secret the desktop app's local stack controller writes into the stack's .env. A request
   * carrying it in `x-orbit-stack-token` is taken to be that controller (see lib/stack.ts).
   */
  stackToken: process.env.STACK_TOKEN ?? '',
  /** Docker image tag this server was built into; what the desktop compares against its desired stack. */
  imageTag: process.env.ORBIT_IMAGE_TAG ?? 'dev',
  updateCheckUrl: process.env.ORBIT_UPDATE_URL ?? 'https://api.github.com/repos/raybello/orbit/releases/latest',
  version: packageVersion(),

  /** Comma-separated emails allowed to sign in; empty = anyone who can reach the app. */
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // ---- per-bot Docker computers ----
  /**
   * Where a bot's computer runs: 'orgo' (the one shared computer), 'docker' (a container per bot)
   * or 'auto' (docker for managed bots, orgo for the primary bot). The primary bot always stays on
   * the Orgo/local path: it is somebody's live desktop.
   */
  computerKind: (process.env.COMPUTER_KIND ?? 'auto').trim().toLowerCase() as 'orgo' | 'docker' | 'auto',
  /** Image for bot containers. Unqualified names are built locally from server/docker/computer.
   *  An empty value (common in a copied .env) means the default, not the empty string. */
  computerImage: (process.env.COMPUTER_IMAGE ?? '').trim() || 'orbit/computer:local',
  /** Minutes without a viewer (or bot work) before a bot's container is suspended. */
  computerIdleTimeoutMin: Number(process.env.COMPUTER_IDLE_TIMEOUT_MIN ?? 30),
  computerCpuLimit: Number(process.env.COMPUTER_CPU_LIMIT ?? 2),
  /** Docker memory limit per container ("2g", "1536m"). */
  computerMemoryLimit: process.env.COMPUTER_MEMORY_LIMIT ?? '2g',
  /** Docker network for bot containers. Ports are published on 127.0.0.1 only. */
  computerNetwork: process.env.COMPUTER_NETWORK ?? 'bridge',
  dockerSocket: process.env.DOCKER_SOCKET ?? '',
  /** Display index ceilings for bot screens (each index owns one VNC and one CDP port). */
  computerMaxDisplays: Number(process.env.COMPUTER_MAX_DISPLAYS ?? 50),
  /**
   * Last-resort model for a managed Bot whose own home names none. A new Bot normally inherits the
   * primary agent's model, so this is only the fallback for a primary with no model configured.
   */
  defaultBotModel: process.env.DEFAULT_BOT_MODEL ?? 'deepseek-flash',
  defaultBotProvider: process.env.DEFAULT_BOT_PROVIDER ?? 'deepseek',
  /** Host directory holding each bot's home folder and workspace checkpoints. */
  computerHomeDir: process.env.COMPUTER_HOME_DIR ?? new URL('../../../data/computers', import.meta.url).pathname,

  // ---- Google OAuth2 (direct, no third-party service required) ----
  /** OAuth2 client ID from your Google Cloud Console project. */
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  /** OAuth2 client secret from your Google Cloud Console project. */
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
};

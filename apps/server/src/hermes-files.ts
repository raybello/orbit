import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * Reading and writing a Hermes home's files. No env, no database: the one-shot import CLI loads
 * this inside a container that has neither.
 */

/** A Hermes config.yaml. Genuinely open-ended: only a handful of keys are ever read here. */
export type HermesConfig = Record<string, unknown>;

/** A config block (providers, mcp_servers, model...): an object, or nothing usable. */
export const asBlock = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Model credentials a managed agent may inherit from the primary agent. Never messaging tokens. */
export const SHARED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY',
  'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
  // DeepSeek, whose key lives in the primary agent's .env.
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  // Hermes reads it for every xAI call (model, x_search, voice), so the US regional choice holds there too.
  'XAI_BASE_URL',
];

/** Parts of the primary agent's config a managed agent starts from, so it reaches the same models. */
export const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary', 'fallback_model', 'fallback_providers', 'mcp_servers'];

/**
 * The env vars that carry model credentials for this config: SHARED_ENV plus every variable a
 * provider block names in `key_env` (a custom provider's key, such as HERMES_CUSTOM_STRATA_API_KEY).
 */
export function modelKeyNames(cfg: HermesConfig): string[] {
  const named = new Set<string>(SHARED_ENV);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'key_env' && typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) named.add(x);
      else walk(x);
    }
  };
  for (const k of SHARED_CONFIG) if (k !== 'mcp_servers') walk(cfg[k]);
  return [...named];
}

/** The endpoint fields of a provider definition that the `model` block must carry with it. */
const ENDPOINT_KEYS = ['base_url', 'api_mode'] as const;

/** A provider this config defines itself: `providers.<id>`, or a `custom_providers` entry by name. */
function definedProvider(cfg: HermesConfig, provider: string): Record<string, unknown> {
  const own = asBlock(asBlock(cfg.providers)[provider]);
  if (Object.keys(own).length) return own;
  const custom = cfg.custom_providers;
  const name = provider.replace(/^custom:/, '');
  if (Array.isArray(custom)) return asBlock(custom.find((p) => asBlock(p).name === name));
  return asBlock(asBlock(custom)[name]);
}

/**
 * Point a config's `model` block at one provider and model. Hermes picks the endpoint from the block,
 * so a provider this config defines (a custom server) brings its `base_url` and `api_mode`, and any
 * other provider gets none: a stale `base_url` left from the previous choice would send the new
 * provider's requests to the old server. A null model means the provider's own default.
 */
export function applyModelChoice(cfg: HermesConfig, provider: string | null, model: string | null): HermesConfig {
  const block: Record<string, unknown> = {};
  if (provider) block.provider = provider;
  if (model) block.default = model;
  const defined = provider ? definedProvider(cfg, provider) : {};
  for (const k of ENDPOINT_KEYS) if (typeof defined[k] === 'string' && defined[k]) block[k] = defined[k];
  cfg.model = block;
  return cfg;
}

/** KEY=value lines of a dotenv file (quotes stripped). Missing file = {}. */
export function readDotenv(file: string): Record<string, string> {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  return parseDotenv(text);
}

/** KEY=value lines of dotenv text (quotes stripped); other lines are skipped. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function dotenvText(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

export function readYaml(file: string): HermesConfig {
  try { return (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as HermesConfig; } catch { return {}; }
}

export function writePrivate(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

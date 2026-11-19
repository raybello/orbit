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
  // DeepSeek is the default model for managed Bots; its key lives in the primary agent's .env.
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  // Hermes reads it for every xAI call (model, x_search, voice), so the US regional choice holds there too.
  'XAI_BASE_URL',
];

/** Parts of the primary agent's config a managed agent starts from, so it reaches the same models. */
export const SHARED_CONFIG = ['model', 'providers', 'custom_providers', 'auxiliary', 'fallback_model', 'fallback_providers', 'mcp_servers'];

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

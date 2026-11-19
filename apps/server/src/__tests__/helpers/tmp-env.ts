/**
 * Test-side isolation for anything that reads env.ts, db.ts or the Hermes homes.
 *
 * env.ts snapshots process.env when it is first imported, so this module must be the FIRST import of
 * a test file; it points DB_PATH and ENGINES_DIR (and with it the primary's home) at a fresh mkdtemp before any
 * other module loads. Import it for the side effect, and read the exported paths to arrange fixtures.
 *
 * Each test file runs in its own process (node --test), so the temp dir it makes is its own; call
 * cleanupTmpEnv() in the last hook so nothing is left behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));
const primary = path.join(root, 'engines', 'primary');
fs.mkdirSync(primary, { recursive: true });

/**
 * Model credentials the server falls back to from its own environment when the primary agent's .env
 * lacks them (engine.ts SHARED_ENV). A developer shell often has some set (ANTHROPIC_BASE_URL, say),
 * which leaked into the credential-sync tests and made them pass under turbo, which filters the
 * environment, but fail when run directly. Tests that want one set it themselves.
 * engine-auth.test.ts checks this list still covers SHARED_ENV.
 */
export const SCRUBBED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'NOUS_API_KEY',
  'FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'XAI_BASE_URL',
];
for (const key of SCRUBBED_ENV) delete process.env[key];

process.env.DB_PATH = path.join(root, 'test.db');
process.env.ENGINES_DIR = path.join(root, 'engines');
// env.ts requires it; the package script sets one too, but direct runs of a single file do not.
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'test-session-secret';

/** The temp root holding every path this test file uses. */
export const tmpRoot = root;
/** env.primaryHome: the primary agent's home, which tests write a .env/config.yaml into. */
export const primaryHome = primary;
/** ENGINES_DIR: where managed bots' homes live. */
export const enginesDir = path.join(root, 'engines');

export function cleanupTmpEnv() {
  fs.rmSync(root, { recursive: true, force: true });
}

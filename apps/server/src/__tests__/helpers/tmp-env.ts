/**
 * Test-side isolation for anything that reads env.ts, db.ts or the Hermes homes.
 *
 * env.ts snapshots process.env when it is first imported, so this module must be the FIRST import of
 * a test file; it points DB_PATH, ENGINES_DIR and HERMES_HOME_PRIMARY at a fresh mkdtemp before any
 * other module loads. Import it for the side effect, and read the exported paths to arrange fixtures.
 *
 * Each test file runs in its own process (node --test), so the temp dir it makes is its own; call
 * cleanupTmpEnv() in the last hook so nothing is left behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-test-'));
const primary = path.join(root, 'primary-home');
fs.mkdirSync(primary, { recursive: true });
fs.mkdirSync(path.join(root, 'engines'), { recursive: true });

process.env.DB_PATH = path.join(root, 'test.db');
process.env.ENGINES_DIR = path.join(root, 'engines');
process.env.HERMES_HOME_PRIMARY = primary;
// env.ts requires it; the package script sets one too, but direct runs of a single file do not.
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'test-session-secret';

/** The temp root holding every path this test file uses. */
export const tmpRoot = root;
/** HERMES_HOME_PRIMARY: the primary agent's home, which tests write a .env/config.yaml into. */
export const primaryHome = primary;
/** ENGINES_DIR: where managed bots' homes live. */
export const enginesDir = path.join(root, 'engines');

export function cleanupTmpEnv() {
  fs.rmSync(root, { recursive: true, force: true });
}

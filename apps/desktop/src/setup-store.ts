/**
 * `userData/setup.json`: the one piece of state that decides what the app opens on launch.
 *
 * The directory is injected (main passes `app.getPath('userData')`) so tests never touch a
 * real profile and so this module stays importable without Electron.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesktopSetup } from './shared/api';
import { normalizeServerUrl } from './setup-config';

const SETUP_FILE = 'setup.json';

let configuredDir: string | null = null;

/** Called once from the main process with `app.getPath('userData')`. */
export function configureSetupStore(dir: string): void {
  configuredDir = dir;
}

function resolveDir(dir?: string): string {
  const chosen = dir ?? configuredDir;
  if (!chosen) {
    throw new Error('setup-store: no userData directory configured (call configureSetupStore first)');
  }
  return chosen;
}

export function setupFilePath(dir?: string): string {
  return path.join(resolveDir(dir), SETUP_FILE);
}

/** Validate before writing so a corrupt setup file is impossible by construction. */
export function assertValidSetup(setup: DesktopSetup): void {
  if (!setup || (setup.mode !== 'new' && setup.mode !== 'existing')) {
    throw new Error("setup-store: mode must be 'new' or 'existing'");
  }
  if (setup.mode === 'existing' && !normalizeServerUrl(setup.serverUrl)) {
    throw new Error('setup-store: an existing-instance setup needs a valid serverUrl');
  }
  // The email becomes an account on the stack; an empty one would sign in as nobody.
  if (setup.email !== undefined && !/^[^@\s]+@[^@\s]+$/.test(String(setup.email))) {
    throw new Error('setup-store: email must look like an email address');
  }
}

export function readSetup(dir?: string): DesktopSetup | null {
  let text: string;
  try {
    text = fs.readFileSync(setupFilePath(dir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A truncated write (crash mid-save) reads as "no setup" and reruns first-run.
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const setup = parsed as DesktopSetup;
  if (setup.mode !== 'new' && setup.mode !== 'existing') return null;
  return setup;
}

/**
 * Write atomically with 0600: the temp file is created mode-first, then renamed over the
 * target, so the secrets-adjacent server URL and headers are never world-readable, even
 * for the instant between create and chmod.
 */
export function writeSetup(dir: string | undefined, setup: DesktopSetup): void {
  assertValidSetup(setup);
  const target = resolveDir(dir);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const file = path.join(target, SETUP_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ ...setup, createdAt: setup.createdAt ?? Date.now() }, null, 2);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // Named volumes/umask variations on Windows make chmod a no-op; ignore failures there.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* not fatal: the file already exists with the mode open(2) gave it */
  }
}

export function clearSetup(dir?: string): void {
  try {
    fs.rmSync(setupFilePath(dir), { force: true });
  } catch {
    /* already gone */
  }
}

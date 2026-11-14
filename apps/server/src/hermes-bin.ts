import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Finding the `hermes` CLI.
 *
 * PATH alone is not enough. The desktop app runs this server inside its Docker image, whose PATH
 * is the image's, and a macOS dev shell often keeps `~/.local/bin` out of the PATH the server was
 * started with. A bot with no engine cannot answer at all, so before giving up we look where
 * Hermes actually installs itself — and when it is nowhere we say what we looked at and how to
 * fix it, because `spawn hermes ENOENT` tells nobody anything.
 *
 * Everything here is a pure function of an explicit lookup, so the search is testable without
 * touching this machine's PATH.
 */

export interface HermesLookup {
  /** HERMES_BIN as configured; '' when unset. May be a path or a bare name. */
  configured: string;
  /** Directories searched like PATH, in order. */
  pathDirs: string[];
  /** Home directory `~` and the known locations resolve against. */
  home: string;
  /** Directories tried after PATH, in order. */
  knownDirs: string[];
  /** True when `file` is a regular executable file. Injected so tests need no real binary. */
  isExecutable: (file: string) => boolean;
}

export type HermesFound = { found: true; path: string; via: 'HERMES_BIN' | 'PATH' | 'known location' };
export type HermesMissing = { found: false; searched: string[]; message: string };
export type HermesResolution = HermesFound | HermesMissing;

/** The PATH a container has when nothing sets one; also what a stripped child env falls back to. */
export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Install URL quoted in the error, so the fix is copy-pasteable. */
const INSTALL_HINT = 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh';

/** Where the CLI lands for the install methods we know about: uv/git installs and distro packages. */
export function knownHermesDirs(home: string): string[] {
  return [
    path.join(home, '.hermes', 'bin'),
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ];
}

export function splitPath(value: string | undefined): string[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
}

/** A file that exists and can be executed by this user. Directories and bare names are not. */
export function executableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `~/x` and `~` resolve against `home`; anything else is left alone. */
export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/** Lookup built from this process's environment. Overrides exist for tests. */
export function defaultHermesLookup(overrides: Partial<HermesLookup> = {}): HermesLookup {
  const home = overrides.home ?? process.env.HOME ?? os.homedir();
  return {
    configured: overrides.configured ?? (process.env.HERMES_BIN ?? '').trim(),
    pathDirs: overrides.pathDirs ?? splitPath(process.env.PATH ?? DEFAULT_PATH),
    home,
    knownDirs: overrides.knownDirs ?? knownHermesDirs(home),
    isExecutable: overrides.isExecutable ?? executableFile,
  };
}

function searchPath(name: string, dirs: string[], searched: string[], isExecutable: (file: string) => boolean): string | null {
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (searched.includes(file)) continue;
    searched.push(file);
    if (isExecutable(file)) return file;
  }
  return null;
}

function looksLikePath(value: string): boolean {
  return value.startsWith('~') || value.includes('/') || value.includes(path.sep);
}

function missingMessage(lookup: HermesLookup, searched: string[]): string {
  const configured = lookup.configured.trim();
  const listed = searched.join(', ');
  const where = `HERMES_BIN${configured ? ` ("${configured}")` : ' is not set'}`;
  return (
    `Hermes is not installed where this server can run it: ${where}, ` +
    `and no executable "hermes" was found at ${listed}. ` +
    `Managed bots need the Hermes CLI to start their engine. ` +
    `Fix: install Hermes (${INSTALL_HINT}) and, if it landed outside those places, ` +
    `point HERMES_BIN at it (e.g. HERMES_BIN=$HOME/.local/bin/hermes, or in the container ` +
    `HERMES_BIN=/opt/hermes/.venv/bin/hermes).`
  );
}

/**
 * Resolve the CLI: HERMES_BIN as a path, then HERMES_BIN (or `hermes`) on PATH, then the known
 * install locations. A configured value that does not resolve is not fatal — we keep looking,
 * and the failure message names it so a wrong HERMES_BIN is obvious.
 */
export function resolveHermesBin(lookup: HermesLookup): HermesResolution {
  const searched: string[] = [];
  const configured = lookup.configured.trim();
  const isExecutable = lookup.isExecutable;

  if (configured && looksLikePath(configured)) {
    const asPath = expandHome(configured, lookup.home);
    searched.push(asPath);
    if (isExecutable(asPath)) return { found: true, path: asPath, via: 'HERMES_BIN' };
  } else {
    const name = configured || 'hermes';
    const hit = searchPath(name, lookup.pathDirs, searched, isExecutable);
    if (hit) return { found: true, path: hit, via: configured ? 'HERMES_BIN' : 'PATH' };
  }

  for (const dir of lookup.knownDirs) {
    const file = path.join(dir, 'hermes');
    if (searched.includes(file)) continue;
    searched.push(file);
    if (isExecutable(file)) return { found: true, path: file, via: 'known location' };
  }

  return { found: false, searched, message: missingMessage(lookup, searched) };
}

let cachedBin: string | null = null;

/**
 * The CLI path for this process, or a throw carrying the actionable message.
 *
 * Successes are cached: the answer cannot change under a running server, and every managed bot
 * asks for it. Misses are not cached, so installing Hermes and retrying works without a restart.
 */
export function hermesBin(lookup: HermesLookup = defaultHermesLookup()): string {
  if (cachedBin) return cachedBin;
  const found = resolveHermesBin(lookup);
  if (!found.found) throw new Error(found.message);
  cachedBin = found.path;
  return found.path;
}

/** Null instead of a throw, for places that only want to report (health, logs). */
export function hermesBinPath(lookup: HermesLookup = defaultHermesLookup()): string | null {
  try {
    return hermesBin(lookup);
  } catch {
    return null;
  }
}

/** Tests only. */
export function resetHermesBinCache(): void {
  cachedBin = null;
}

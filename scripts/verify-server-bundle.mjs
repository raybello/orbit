#!/usr/bin/env node
/**
 * Can this server bundle run local voice?
 *
 * The macOS native stack runs a downloaded server bundle (`installServerBundle` in
 * apps/desktop/src/mac-runtime.ts) as a plain Node process out of the archive — there is no
 * `pnpm install` on the user's machine afterwards. So the sherpa-onnx native addon and its
 * prebuilt darwin-arm64 platform package (the `.node` plus three dylibs) have to be inside the
 * tarball, or local voice silently never turns on: the server reports `runtime.addon: false` and
 * the client stays on the cloud path. That degradation is by design (see the degraded-path test),
 * but a release should not ship it by accident. This script is the release gate.
 *
 *   node scripts/verify-server-bundle.mjs <bundle.tar.xz | unpacked-bundle-dir> [--keep]
 *
 *     --keep        do not delete the temporary extraction directory (printed in the header)
 *     --node <bin>  node binary for the `require()` probe (default: the node running this script)
 *     --quiet       only the verdict line
 *     -h, --help    this text
 *
 * Exit codes: 0 = can ship local voice, 1 = cannot, 2 = usage error.
 * Node stdlib + the system `tar` only, no dependencies, so it runs in CI without an install.
 *
 * The checklist (each line is one assertion):
 *   1. the archive unpacks with `tar -xJf` (a directory is accepted as-is)
 *   2. the manifest entrypoint exists: `apps/server/dist/index.js`, or `dist/index.js` at the root
 *   3. `node_modules/sherpa-onnx-node` is there (its package.json is on disk; pnpm's `.pnpm` store
 *      layout counts, because that is how the dependency actually lands in node_modules)
 *   4. the darwin-arm64 binary ships: `sherpa-onnx-darwin-arm64/sherpa-onnx.node`, or the
 *      `sherpa-onnx-node/build/Release/sherpa-onnx.node` fallback of a source build
 *   5. the three dylibs that binary dlopens ship next to it
 *   6. `node -e "require('sherpa-onnx-node')"` really loads (skipped, not failed, with no node)
 *   7. no model directory is bundled — the 263 MB of ONNX is downloaded per user at runtime
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Where `server-bundle.json` points `entrypoints.api`: the tarball may root at the repo or at apps/server. */
export const ENTRYPOINTS = ['apps/server/dist/index.js', 'dist/index.js'];
export const ADDON_PACKAGE = 'sherpa-onnx-node';
export const PLATFORM_PACKAGE = 'sherpa-onnx-darwin-arm64';
export const PLATFORM_BINARY = 'sherpa-onnx.node';
/** Loaded by the addon at dlopen time; a bundle with the `.node` and without these is still broken. */
export const PLATFORM_DYLIBS = [
  'libsherpa-onnx-c-api.dylib',
  'libsherpa-onnx-cxx-api.dylib',
  'libonnxruntime.dylib',
];
/** Directories that only ever exist when someone packed a model cache into the bundle. */
const MODEL_DIR_NAMES = new Set(['voice-models', 'espeak-ng-data']);
/** Never walked when looking for bundled models: dependencies ship no model files. */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Extraction dirs that still exist. Deleted in `finish()`; the exit hook is only the safety net
 * for an unexpected throw or a Ctrl-C, so a verification run never leaves 100 MB in TMPDIR.
 */
const pendingTempDirs = new Set();
process.on('exit', () => {
  for (const dir of pendingTempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort on the way out */
    }
  }
  pendingTempDirs.clear();
});

const LABELS = {
  unpack: 'archive unpacks',
  entrypoint: 'manifest entrypoint',
  addon: 'node_modules/sherpa-onnx-node',
  platform: 'sherpa-onnx-darwin-arm64 binary',
  dylibs: 'darwin-arm64 dylibs',
  load: "require('sherpa-onnx-node')",
  models: 'no bundled model dir',
};

function rel(root, file) {
  const r = path.relative(root, file);
  return r && !r.startsWith('..') ? r : file;
}

function exists(file) {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** `.pnpm/sherpa-onnx-node@1.13.8/node_modules/sherpa-onnx-node` — the pnpm store layout. */
function pnpmPackageDir(nodeModules, name) {
  const store = path.join(nodeModules, '.pnpm');
  let entries;
  try {
    entries = fs.readdirSync(store);
  } catch {
    return null;
  }
  const prefix = `${name}@`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const dir = path.join(store, entry, 'node_modules', name);
    if (exists(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

/** Every `node_modules` a bundle root plausibly has: hoisted at the root, or next to apps/server. */
function nodeModulesDirs(root) {
  return [path.join(root, 'node_modules'), path.join(root, 'apps', 'server', 'node_modules')];
}

export function findEntrypoint(root) {
  for (const candidate of ENTRYPOINTS) {
    const file = path.join(root, candidate);
    if (exists(file)) return { entrypoint: candidate, file };
  }
  return null;
}

/**
 * The addon package, its package.json and the `node_modules` it was found in.
 * A miss returns the search list so the failure message says where we looked.
 */
export function findAddonPackage(root) {
  const looked = nodeModulesDirs(root).map((nm) => rel(root, path.join(nm, ADDON_PACKAGE, 'package.json')));
  for (const nodeModules of nodeModulesDirs(root)) {
    const dir = path.join(nodeModules, ADDON_PACKAGE);
    if (exists(path.join(dir, 'package.json'))) return { dir, nodeModules, looked };
    const stored = pnpmPackageDir(nodeModules, ADDON_PACKAGE);
    if (stored) return { dir: stored, nodeModules, looked };
  }
  return { dir: null, nodeModules: null, looked };
}

/**
 * The prebuilt darwin-arm64 binary, next to the addon package (hoisted or nested) or in the
 * pnpm store; null when only the source-build fallback could satisfy it.
 */
export function findPlatformDir(addon, root) {
  const dirs = [
    path.join(path.dirname(addon.dir), PLATFORM_PACKAGE),
    path.join(addon.dir, 'node_modules', PLATFORM_PACKAGE),
  ];
  for (const dir of dirs) {
    if (exists(path.join(dir, PLATFORM_BINARY))) return { dir, source: 'package' };
  }
  const stored = pnpmPackageDir(addon.nodeModules, PLATFORM_PACKAGE);
  if (stored && exists(path.join(stored, PLATFORM_BINARY))) return { dir: stored, source: 'package' };
  const build = path.join(addon.dir, 'build', 'Release', PLATFORM_BINARY);
  if (exists(build)) return { dir: path.dirname(build), source: 'build' };
  return null;
}

/**
 * Every `voice-models`, `espeak-ng-data` directory and `.onnx` file outside node_modules.
 * Models are downloaded per user (`VOICE_MODELS_DIR`); packing them makes the archive huge and
 * makes the checker lie about what the user has.
 */
export function bundledModelHits(root, limit = 4) {
  const hits = [];
  const walk = (dir, depth) => {
    if (hits.length >= limit || depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= limit) return;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (MODEL_DIR_NAMES.has(entry.name)) {
          hits.push(`${rel(root, full)}/`);
          continue;
        }
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.onnx')) {
        hits.push(rel(root, full));
      }
    }
  };
  walk(root, 0);
  return hits;
}

/** `require('sherpa-onnx-node')` from the directory whose node_modules holds the package. */
function requireFrom(cwd, nodeBin, platformDir) {
  const env = { ...process.env };
  if (platformDir) {
    const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    const current = env[key];
    env[key] = current ? `${platformDir}:${current}` : platformDir;
  }
  return spawnSync(nodeBin, ['-e', `require('${ADDON_PACKAGE}')`], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function unpack(archive, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-server-bundle-'));
  if (!opts.keepTemp) pendingTempDirs.add(dir);
  const result = spawnSync('tar', ['-xJf', archive, '-C', dir], { encoding: 'utf8', timeout: 600_000 });
  if (result.error) {
    pendingTempDirs.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    const code = result.error.code ?? 'unknown';
    const detail = code === 'ENOENT' ? 'tar is not installed (needed to unpack .tar.xz)' : String(result.error.message);
    return { dir: null, detail, temp: false };
  }
  if (result.status !== 0) {
    pendingTempDirs.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    const first = String(result.stderr ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${result.status}`;
    return { dir: null, detail: `tar -xJf failed: ${first}`, temp: false };
  }
  return { dir, temp: !opts.keepTemp };
}

/**
 * Run the checklist. Pure enough to unit-test: returns the checks, never prints, never exits.
 * The temp extraction directory is removed unless `opts.keepTemp`.
 */
export function verifyServerBundle(target, opts = {}) {
  const abs = path.resolve(String(target));
  const nodeBin = opts.nodeBin ?? process.execPath;
  const checks = [];
  const record = (id, status, detail) => checks.push({ id, label: LABELS[id], status, detail });

  let isDir;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    return {
      target: abs,
      ok: false,
      kind: 'missing',
      checks: [],
      bundleRoot: null,
      error: `no such file or directory: ${abs}`,
    };
  }

  const kind = isDir ? 'directory' : abs.endsWith('.tar.xz') || abs.endsWith('.txz') ? 'tar.xz' : 'archive';
  let root = abs;
  let tempDir = null;

  if (isDir) {
    record('unpack', 'ok', 'unpacked directory');
  } else {
    const extracted = unpack(abs, opts);
    if (!extracted.dir) {
      record('unpack', 'fail', extracted.detail);
      return { target: abs, ok: false, kind, checks, bundleRoot: null, extractDir: null };
    }
    // `--keep` leaves it on disk so a human can look; otherwise it goes away with the report.
    tempDir = extracted.temp ? extracted.dir : null;
    record('unpack', 'ok', `tar -xJf ${path.basename(abs)}`);
    // A tarball built with `.` at its root unpacks straight here; one built around a top-level
    // directory carries exactly one entry and that is the bundle root. Decide by where the
    // entrypoint is, never by counting directories — `dist/` is a directory too.
    root = extracted.dir;
    let found = findEntrypoint(root);
    if (!found) {
      const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (dirs.length === 1) {
        const nested = path.join(root, dirs[0].name);
        found = findEntrypoint(nested);
        if (found) root = nested;
      }
    }
  }

  const finish = () => {
    const failed = checks.filter((c) => c.status === 'fail').length;
    const skipped = checks.filter((c) => c.status === 'skip').length;
    const ok = failed === 0;
    const extractDir = tempDir;
    if (tempDir) {
      pendingTempDirs.delete(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return { target: abs, ok, kind, checks, bundleRoot: root, extractDir, failed, skipped };
  };

  const entry = findEntrypoint(root);
  if (entry) record('entrypoint', 'ok', entry.entrypoint);
  else record('entrypoint', 'fail', `not found: neither ${ENTRYPOINTS[0]} nor ${ENTRYPOINTS[1]} is in the bundle`);

  const addon = findAddonPackage(root);
  let addonDir = addon.dir;
  if (addonDir) {
    let version = '';
    try {
      version = String(JSON.parse(fs.readFileSync(path.join(addonDir, 'package.json'), 'utf8'))?.version ?? '');
    } catch {
      /* the package.json existing is what counts; its version is only decoration */
    }
    record('addon', 'ok', `${rel(root, addonDir)}${version ? ` (${version})` : ''}`);
  } else {
    addonDir = null;
    record('addon', 'fail', `not found (looked for ${addon.looked.join(', ')} and pnpm's node_modules/.pnpm/${ADDON_PACKAGE}@*)`);
  }

  const platform = addonDir ? findPlatformDir({ dir: addonDir, nodeModules: addon.nodeModules }, root) : null;
  let platformDir = null;
  if (!addonDir) {
    record('platform', 'skip', `skipped: no ${ADDON_PACKAGE} package to resolve the platform binary against`);
  } else if (!platform) {
    record(
      'platform',
      'fail',
      `not found: expected ${rel(root, path.join(addon.nodeModules, PLATFORM_PACKAGE, PLATFORM_BINARY))} ` +
        `or ${rel(root, path.join(addonDir, 'build', 'Release', PLATFORM_BINARY))}`,
    );
  } else {
    platformDir = platform.dir;
    record('platform', 'ok', rel(root, path.join(platformDir, PLATFORM_BINARY)));
  }

  if (!platformDir) {
    record('dylibs', 'skip', 'skipped: no darwin-arm64 package to inspect');
  } else if (platform.source === 'build') {
    record('dylibs', 'skip', 'skipped: a build/Release binary links its own libraries');
  } else {
    const missing = PLATFORM_DYLIBS.filter((name) => !exists(path.join(platformDir, name)));
    if (missing.length) record('dylibs', 'fail', `missing ${missing.join(', ')} in ${rel(root, platformDir)}`);
    else record('dylibs', 'ok', PLATFORM_DYLIBS.join(', '));
  }

  if (!addonDir) {
    record('load', 'skip', `skipped: no ${ADDON_PACKAGE} package to require`);
  } else if (nodeBin && exists(nodeBin)) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const at = addonDir.lastIndexOf(marker);
    const cwd = at === -1 ? root : addonDir.slice(0, at);
    const probe = requireFrom(cwd, nodeBin, platformDir);
    if (probe.error) {
      record('load', 'skip', `skipped: could not run ${nodeBin}: ${probe.error.code ?? probe.error.message}`);
    } else if (probe.status === 0) {
      record('load', 'ok', 'loaded');
    } else {
      const stderr = String(probe.stderr ?? '').trim();
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      // Node prints the throwing source line first; the useful part is the `Error: …` header.
      const line =
        lines.find((l) => /^(\w*Error|Error \[[^\]]+\]):/.test(l)) ??
        lines.find((l) => /Error|error:/.test(l)) ??
        lines[0] ??
        '';
      record('load', 'fail', `node could not load it: ${line || `exit ${probe.status}`}`);
    }
  } else {
    record('load', 'skip', `skipped: no node binary at ${nodeBin} (pass --node /path/to/node)`);
  }

  const hits = bundledModelHits(root);
  if (hits.length) record('models', 'fail', `bundled: ${hits.join(', ')} (models are downloaded per user)`);
  else record('models', 'ok', 'no voice-models dir and no .onnx files outside node_modules');

  return finish();
}

/** The checklist as the terminal shows it: one aligned line per assertion, then the verdict. */
export function formatReport(result) {
  const lines = ['verify-server-bundle', `target:  ${result.target}`];
  if (result.kind) lines.push(`format:  ${result.kind}`);
  if (result.bundleRoot) lines.push(`bundle:  ${result.bundleRoot}`);
  lines.push('');
  const width = Math.max(...Object.values(LABELS).map((l) => l.length)) + 2;
  for (const check of result.checks) {
    const tag = check.status === 'ok' ? '[ok]  ' : check.status === 'skip' ? '[skip]' : '[FAIL]';
    lines.push(`  ${tag} ${check.label.padEnd(width)}${check.detail}`);
  }
  lines.push('');
  const total = result.checks.length;
  const failed = result.failed ?? result.checks.filter((c) => c.status === 'fail').length;
  const skipped = result.skipped ?? result.checks.filter((c) => c.status === 'skip').length;
  if (result.error) lines.push(`FAIL — ${result.error}`);
  else if (failed) lines.push(`FAIL — ${failed} of ${total} checks failed; this bundle cannot run local voice.`);
  else lines.push(`PASS — local voice will work from this bundle (${total} checks, ${skipped} skipped).`);
  return lines.join('\n');
}

function usage() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const header = text.slice(text.indexOf('/**') + 3, text.indexOf('*/')).replace(/^ \* ?/gm, '');
  process.stdout.write(`${header.trim()}\n`);
}

function main(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      usage();
      return 0;
    }
    if (arg === '--keep') opts.keepTemp = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--node') {
      opts.nodeBin = argv[++i];
      if (!opts.nodeBin) {
        process.stderr.write('--node needs a path\n');
        return 2;
      }
    } else if (arg.startsWith('-')) {
      process.stderr.write(`unknown option: ${arg}\n`);
      return 2;
    } else positional.push(arg);
  }

  if (positional.length !== 1) {
    process.stderr.write('usage: node scripts/verify-server-bundle.mjs <bundle.tar.xz | unpacked-bundle-dir> [--keep] [--node <bin>]\n');
    return 2;
  }

  const result = verifyServerBundle(positional[0], opts);
  if (opts.quiet) {
    const failed = result.checks.filter((c) => c.status === 'fail');
    process.stdout.write(result.ok ? 'PASS\n' : `FAIL ${failed.map((c) => `${c.label}: ${c.detail}`).join('; ')}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
    if (result.tempDir) process.stdout.write(`extracted to ${result.tempDir}\n`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));

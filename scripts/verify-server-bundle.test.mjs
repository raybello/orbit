/**
 * The test for `scripts/verify-server-bundle.mjs` — proves the release gate actually fails.
 *
 * A checker nobody has seen fail is not a checker. Each case here builds a throwaway bundle in a
 * temp dir, packs it with the system `tar` + `xz` (`tar -cJf`), runs the real CLI as a child
 * process, and asserts the exact status/detail line and exit code.
 *
 *   node --test scripts/verify-server-bundle.test.mjs
 *
 * Deliberately not part of `pnpm --filter @orbit/server test`: it needs no tsx, no database and no
 * 263 MB model cache, so it can run in a bare CI job (and it stays out of the voice agents' file).
 * The stubs are shaped like sherpa-onnx-node@1.13.8 rather than copied from node_modules, which
 * keeps the test hermetic; `--real` evidence lives in docs/local-voice-status.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { PLATFORM_DYLIBS, verifyServerBundle, formatReport } from './verify-server-bundle.mjs';

const SCRIPT = new URL('./verify-server-bundle.mjs', import.meta.url).pathname;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-bundle-test-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ---------- building throwaway bundles ----------

let seq = 0;
function tmp(label) {
  seq += 1;
  const dir = path.join(ROOT, `${seq}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * A bundle directory with an entrypoint, and (unless `addon: 'none'`) an addon package.
 *
 * `addon.layout`:
 *   'hoisted'  node_modules/{sherpa-onnx-node,sherpa-onnx-darwin-arm64} — pnpm's public face
 *   'pnpm'     node_modules/.pnpm/sherpa-onnx-node@1.13.8/node_modules/{…,sherpa-onnx-darwin-arm64}
 *   'build'    node_modules/sherpa-onnx-node/build/Release/sherpa-onnx.node, no platform package
 *   'none'     no node_modules at all
 */
function buildBundle(label, { entrypoint = 'apps/server/dist/index.js', addon = {}, models = false, wrap = null } = {}) {
  const layout = addon.layout ?? 'hoisted';
  const dir = tmp(label);
  write(path.join(dir, entrypoint), "console.log('orbit server');\n");

  if (layout !== 'none') {
    const nm = layout === 'pnpm'
      ? path.join(dir, 'node_modules', '.pnpm', 'sherpa-onnx-node@1.13.8', 'node_modules')
      : path.join(dir, 'node_modules');
    const addonDir = path.join(nm, 'sherpa-onnx-node');
    write(path.join(addonDir, 'package.json'), json({ name: 'sherpa-onnx-node', version: '1.13.8', main: 'sherpa-onnx.js' }));
    write(
      path.join(addonDir, 'sherpa-onnx.js'),
      addon.main ?? "module.exports = { version: 'stub', OnlineRecognizer: function () {}, OfflineTts: function () {}, Vad: function () {} };\n",
    );

    if (layout === 'build') {
      if (addon.binary !== false) write(path.join(addonDir, 'build', 'Release', 'sherpa-onnx.node'), 'stub binary (source build)\n');
    } else {
      const platformDir = path.join(nm, 'sherpa-onnx-darwin-arm64');
      write(path.join(platformDir, 'package.json'), json({ name: 'sherpa-onnx-darwin-arm64', version: '1.13.8' }));
      write(path.join(platformDir, 'index.js'), "module.exports = require('./sherpa-onnx.node');\n");
      if (addon.binary !== false) write(path.join(platformDir, 'sherpa-onnx.node'), 'stub binary (prebuilt)\n');
      for (const dylib of PLATFORM_DYLIBS) {
        if (addon.dylibs === 'missing-one' && dylib === 'libonnxruntime.dylib') continue;
        write(path.join(platformDir, dylib), 'stub dylib\n');
      }
    }
  }

  if (models) {
    write(path.join(dir, 'voice-models', 'tts', 'en_US-lessac-medium.onnx'), 'not a real model\n');
    write(path.join(dir, 'voice-models', 'tts', 'tokens.txt'), 'stub\n');
  }

  if (!wrap) return dir;
  // A tarball built around one top-level directory: the installer (and the checker) must find the
  // bundle root inside it instead of assuming the archive root is the bundle.
  const outer = tmp(`${label}-wrapped`);
  const inner = path.join(outer, wrap);
  fs.renameSync(dir, inner);
  return outer;
}

/** `tar` + `xz` as two child processes — the same tools (and the same format) the mac installer unpacks. */
function pack(dir, archiveName) {
  const archive = path.join(ROOT, archiveName);
  // xz replaces <name>.tar with <name>.tar.xz, so the intermediate must drop the .xz suffix.
  const tarFile = archive.replace(/\.xz$/, '');
  execFileSync('tar', ['-cf', tarFile, '-C', dir, '.'], { stdio: 'pipe' });
  execFileSync('xz', ['-z', '-f', '-6', tarFile], { stdio: 'pipe' });
  assert.ok(fs.existsSync(archive), `tar + xz should produce ${archive}`);
  return archive;
}

/** Run the real CLI and return exit code + stdout, so assertions cover what a human sees. */
function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { code: result.status, out: String(result.stdout), err: String(result.stderr) };
}

/** One checklist line, parsed back into status + detail so the padding cannot hide a change. */
function check(out, label) {
  const line = out.split('\n').find((l) => l.includes(` ${label}`) && /^\s*\[(ok|skip|FAIL)\]/.test(l));
  assert.ok(line, `no checklist line for ${JSON.stringify(label)} in:\n${out}`);
  const status = /\[ok\]/.test(line) ? 'ok' : /\[skip\]/.test(line) ? 'skip' : 'fail';
  const detail = line.slice(line.indexOf(label) + label.length).trim();
  return { status, detail };
}

function verdict(out) {
  return out.trim().split('\n').filter((l) => l.startsWith('PASS') || l.startsWith('FAIL')).at(-1);
}

// ---------- 1. the archive that can ship local voice ----------

test('a bundle with the darwin-arm64 addon passes', () => {
  const archive = pack(buildBundle('good'), 'good.tar.xz');
  const { code, out } = run(archive);

  assert.equal(code, 0, `expected exit 0 for a good bundle:\n${out}`);
  assert.deepEqual(check(out, 'archive unpacks'), { status: 'ok', detail: 'tar -xJf good.tar.xz' });
  assert.deepEqual(check(out, 'manifest entrypoint'), { status: 'ok', detail: 'apps/server/dist/index.js' });
  assert.deepEqual(check(out, 'node_modules/sherpa-onnx-node'), {
    status: 'ok',
    detail: 'node_modules/sherpa-onnx-node (1.13.8)',
  });
  assert.deepEqual(check(out, 'sherpa-onnx-darwin-arm64 binary'), {
    status: 'ok',
    detail: 'node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node',
  });
  assert.deepEqual(check(out, 'darwin-arm64 dylibs'), {
    status: 'ok',
    detail: 'libsherpa-onnx-c-api.dylib, libsherpa-onnx-cxx-api.dylib, libonnxruntime.dylib',
  });
  assert.deepEqual(check(out, "require('sherpa-onnx-node')"), { status: 'ok', detail: 'loaded' });
  assert.deepEqual(check(out, 'no bundled model dir'), {
    status: 'ok',
    detail: 'no voice-models dir and no .onnx files outside node_modules',
  });
  assert.equal(verdict(out), 'PASS — local voice will work from this bundle (7 checks, 0 skipped).');
});

// ---------- 2. the archive that cannot ----------

test('a bundle without the addon fails, naming what it looked for', () => {
  const archive = pack(buildBundle('no-addon', { addon: { layout: 'none' } }), 'no-addon.tar.xz');
  const { code, out } = run(archive);

  assert.equal(code, 1, `expected exit 1 with no addon:\n${out}`);
  assert.deepEqual(check(out, 'archive unpacks'), { status: 'ok', detail: 'tar -xJf no-addon.tar.xz' });
  // The entrypoint is still fine: the failure must point at the addon, not at the server build.
  assert.deepEqual(check(out, 'manifest entrypoint'), { status: 'ok', detail: 'apps/server/dist/index.js' });
  assert.deepEqual(check(out, 'node_modules/sherpa-onnx-node'), {
    status: 'fail',
    detail:
      "not found (looked for node_modules/sherpa-onnx-node/package.json, " +
      "apps/server/node_modules/sherpa-onnx-node/package.json and pnpm's node_modules/.pnpm/sherpa-onnx-node@*)",
  });
  // Dependent checks say why they could not run instead of adding noise to the failure count.
  assert.deepEqual(check(out, 'sherpa-onnx-darwin-arm64 binary'), {
    status: 'skip',
    detail: 'skipped: no sherpa-onnx-node package to resolve the platform binary against',
  });
  assert.deepEqual(check(out, "require('sherpa-onnx-node')"), {
    status: 'skip',
    detail: 'skipped: no sherpa-onnx-node package to require',
  });
  assert.equal(verdict(out), 'FAIL — 1 of 7 checks failed; this bundle cannot run local voice.');
});

// ---------- 3. the layouts a real bundle actually has ----------

test('a tarball wrapped in one directory resolves the bundle root', () => {
  const archive = pack(
    buildBundle('wrapped', { entrypoint: 'dist/index.js', wrap: 'orbit-server-1.2.3' }),
    'wrapped.tar.xz',
  );
  const { code, out } = run(archive);
  assert.equal(code, 0, `a single top-level directory is a legal layout:\n${out}`);
  assert.deepEqual(check(out, 'manifest entrypoint'), { status: 'ok', detail: 'dist/index.js' });
});

test("pnpm's .pnpm store layout resolves the addon and its platform package", () => {
  const archive = pack(buildBundle('pnpm', { addon: { layout: 'pnpm' } }), 'pnpm.tar.xz');
  const { code, out } = run(archive);
  assert.equal(code, 0, `pnpm layout must pass:\n${out}`);
  assert.deepEqual(check(out, 'node_modules/sherpa-onnx-node'), {
    status: 'ok',
    detail: 'node_modules/.pnpm/sherpa-onnx-node@1.13.8/node_modules/sherpa-onnx-node (1.13.8)',
  });
  // The probe runs from the directory whose node_modules holds the package, which is how the
  // server's own `require('sherpa-onnx-node')` resolves after unpacking.
  assert.deepEqual(check(out, "require('sherpa-onnx-node')"), { status: 'ok', detail: 'loaded' });
});

test('a source build with only build/Release/sherpa-onnx.node passes, and says dylibs are theirs', () => {
  const archive = pack(buildBundle('build', { addon: { layout: 'build' } }), 'build.tar.xz');
  const { code, out } = run(archive);
  assert.equal(code, 0, `build/Release is the documented fallback:\n${out}`);
  assert.deepEqual(check(out, 'sherpa-onnx-darwin-arm64 binary'), {
    status: 'ok',
    detail: 'node_modules/sherpa-onnx-node/build/Release/sherpa-onnx.node',
  });
  assert.deepEqual(check(out, 'darwin-arm64 dylibs'), {
    status: 'skip',
    detail: 'skipped: a build/Release binary links its own libraries',
  });
});

test('an unpacked bundle directory is checked without tar', () => {
  const dir = buildBundle('dir-input');
  const { code, out } = run(dir);
  assert.equal(code, 0, `a directory must be accepted:\n${out}`);
  assert.deepEqual(check(out, 'archive unpacks'), { status: 'ok', detail: 'unpacked directory' });
  assert.equal(verdict(out), 'PASS — local voice will work from this bundle (7 checks, 0 skipped).');
});

// ---------- 4. the ways it breaks in the wild ----------

test('the addon package without its platform binary fails', () => {
  const archive = pack(buildBundle('no-binary', { addon: { binary: false } }), 'no-binary.tar.xz');
  const { code, out } = run(archive);
  assert.equal(code, 1, `a package with no .node cannot work:\n${out}`);
  assert.deepEqual(check(out, 'sherpa-onnx-darwin-arm64 binary'), {
    status: 'fail',
    detail:
      'not found: expected node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node ' +
      'or node_modules/sherpa-onnx-node/build/Release/sherpa-onnx.node',
  });
  assert.equal(verdict(out), 'FAIL — 1 of 7 checks failed; this bundle cannot run local voice.');
});

test('the .node without its dylibs fails: the addon would not dlopen', () => {
  const archive = pack(buildBundle('no-dylib', { addon: { dylibs: 'missing-one' } }), 'no-dylib.tar.xz');
  const { code, out } = run(archive);
  assert.equal(code, 1, `missing libonnxruntime.dylib must fail:\n${out}`);
  assert.deepEqual(check(out, 'darwin-arm64 dylibs'), {
    status: 'fail',
    detail: 'missing libonnxruntime.dylib in node_modules/sherpa-onnx-darwin-arm64',
  });
});

test('an addon that throws on require fails with the loader message', () => {
  const throwing = "throw new Error('Error loading shared library libonnxruntime.dylib');\n";
  const archive = pack(buildBundle('bad-addon', { addon: { main: throwing } }), 'bad-addon.tar.xz');
  const { code, out } = run(archive);
  assert.equal(code, 1, `a broken addon must fail:\n${out}`);
  assert.deepEqual(check(out, "require('sherpa-onnx-node')"), {
    status: 'fail',
    detail: 'node could not load it: Error: Error loading shared library libonnxruntime.dylib',
  });
});

test('a bundled model directory fails: models are downloaded per user', () => {
  const archive = pack(buildBundle('with-models', { models: true }), 'with-models.tar.xz');
  const { code, out } = run(archive);
  assert.equal(code, 1, `models must not ship inside the archive:\n${out}`);
  assert.deepEqual(check(out, 'no bundled model dir'), {
    status: 'fail',
    detail: 'bundled: voice-models/ (models are downloaded per user)',
  });
});

test('with no node binary the require probe skips instead of failing the bundle', () => {
  const archive = pack(buildBundle('no-node'), 'no-node.tar.xz');
  const { code, out } = run(archive, '--node', path.join(ROOT, 'definitely-not-node'));
  assert.equal(code, 0, `a missing node is a skip, not a defect in the bundle:\n${out}`);
  assert.deepEqual(check(out, "require('sherpa-onnx-node')"), {
    status: 'skip',
    detail: `skipped: no node binary at ${path.join(ROOT, 'definitely-not-node')} (pass --node /path/to/node)`,
  });
  assert.equal(verdict(out), 'PASS — local voice will work from this bundle (7 checks, 1 skipped).');
});

// ---------- 5. usage errors, so a typo in CI is not mistaken for a broken bundle ----------

test('a missing path is a failure with a plain message, and --help is not', () => {
  const missing = run(path.join(ROOT, 'no-such-bundle.tar.xz'));
  assert.equal(missing.code, 1, 'a missing archive must exit 1');
  assert.equal(verdict(missing.out), `FAIL — no such file or directory: ${path.join(ROOT, 'no-such-bundle.tar.xz')}`);

  const help = run('--help');
  assert.equal(help.code, 0, '--help exits 0');
  assert.match(help.out, /node scripts\/verify-server-bundle\.mjs <bundle\.tar\.xz \| unpacked-bundle-dir>/);

  const usage = run();
  assert.equal(usage.code, 2, 'no argument is a usage error, not a bundle failure');
});

// ---------- 6. the library API the CLI wraps ----------

test('verifyServerBundle returns the same verdict the CLI reports', () => {
  const dir = buildBundle('api');
  const result = verifyServerBundle(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.checks.map((c) => [c.label, c.status]).sort(),
    [
      ['archive unpacks', 'ok'],
      ['darwin-arm64 dylibs', 'ok'],
      ['manifest entrypoint', 'ok'],
      ['no bundled model dir', 'ok'],
      ["require('sherpa-onnx-node')", 'ok'],
      ['node_modules/sherpa-onnx-node', 'ok'],
      ['sherpa-onnx-darwin-arm64 binary', 'ok'],
    ].sort(),
  );
  assert.match(formatReport(result), /^PASS — local voice will work from this bundle \(7 checks, 0 skipped\)\.$/m);
});

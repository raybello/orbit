/**
 * The desktop bundle: three entry points and two static files.
 *
 * Deliberately boring and deterministic — no hashing, no minification of the main
 * process (a stack trace with real names is worth more than 40KB), and a hard failure
 * with a readable message when an input is missing.
 */

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

/** Fail before esbuild does, with a message that names the file. */
function requireFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`desktop build: missing input ${path.relative(root, file)}`);
  }
  return file;
}

function clean() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
}

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  // A build that silently produces an empty bundle is worse than a failing build.
  metafile: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

async function buildMain() {
  return build({
    ...shared,
    entryPoints: [requireFile(path.join(src, 'main.ts'))],
    outfile: path.join(dist, 'main.js'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Electron and the updater ship their own binaries and must not be inlined. Everything
    // else (including @orbit/contracts and @orbit/logger) is bundled: the packaged app
    // then needs no node_modules to start.
    external: ['electron', 'electron-updater'],
    banner: {
      // ESM output plus __dirname-using dependencies: give them a real __dirname.
      js: [
        "import { createRequire as __orbitCreateRequire } from 'node:module';",
        'const require = __orbitCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  });
}

async function buildPreload() {
  return build({
    ...shared,
    entryPoints: [requireFile(path.join(src, 'preload.cjs'))],
    outfile: path.join(dist, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // A preload script is CommonJS and must keep requiring electron at runtime.
    external: ['electron'],
    sourcemap: false,
  });
}

async function buildSetupRenderer() {
  return build({
    ...shared,
    entryPoints: [requireFile(path.join(src, 'setup.ts'))],
    outfile: path.join(dist, 'setup.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    sourcemap: false,
  });
}

function copyStatic() {
  for (const name of ['setup.html', 'setup.css']) {
    const from = requireFile(path.join(src, name));
    fs.copyFileSync(from, path.join(dist, name));
  }
}

async function main() {
  const started = Date.now();
  clean();
  const [mainResult, preloadResult, setupResult] = await Promise.all([
    buildMain(),
    buildPreload(),
    buildSetupRenderer(),
  ]);
  copyStatic();

  for (const name of ['main.js', 'preload.cjs', 'setup.js', 'setup.html', 'setup.css']) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      throw new Error(`desktop build: ${name} was not produced`);
    }
  }

  const sizes = fs
    .readdirSync(dist)
    .filter((f) => !f.endsWith('.map'))
    .map((f) => `  ${f.padEnd(16)} ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(1)} kB`)
    .join('\n');
  const warnings = [mainResult, preloadResult, setupResult].flatMap((r) => r.warnings ?? []);
  console.log(`[desktop] built in ${Date.now() - started}ms\n${sizes}`);
  if (warnings.length) {
    console.log(`[desktop] ${warnings.length} esbuild warning(s)`);
    for (const warning of warnings) console.log(`  ${warning.text}`);
  }
}

main().catch((err) => {
  console.error(`[desktop] build failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

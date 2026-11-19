#!/usr/bin/env node
/**
 * Rewrites relative imports that resolve to apps/server/src/types.ts (the @orbit/contracts
 * re-export shim) to import directly from @orbit/contracts.
 *
 * Idempotent: re-running on an already-migrated tree produces an empty diff.
 *
 *   node scripts/codemod-contracts-imports.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SERVER_SRC = path.join(ROOT, 'apps', 'server', 'src');
const SHIM_PATH = path.join(SERVER_SRC, 'types.ts');
const DRY_RUN = process.argv.includes('--dry-run');

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

const IMPORT_RE = /from\s+'(\.\.?\/[^']*types\.js)'/g;

let changed = 0;

for (const file of walk(SERVER_SRC)) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);

  let next = src.replace(IMPORT_RE, (match, specifier) => {
    const resolved = path.resolve(dir, specifier.replace(/\.js$/, '.ts'));
    if (resolved !== SHIM_PATH) return match;
    return match.replace(specifier, '@orbit/contracts');
  });

  if (next !== src) {
    if (!DRY_RUN) fs.writeFileSync(file, next, 'utf8');
    console.log(`${DRY_RUN ? '[dry] ' : ''}rewrote ${path.relative(ROOT, file)}`);
    changed++;
  }
}

console.log(`${changed} file(s) ${DRY_RUN ? 'would be ' : ''}rewritten.`);

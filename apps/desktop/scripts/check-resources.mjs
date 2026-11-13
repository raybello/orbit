/**
 * Pre-flight for `pack` / `release`.
 *
 * `electron-builder` fails on a missing `extraResources` source with a message about a
 * glob, several minutes into a build. This checks the three paths first and says exactly
 * what is missing and who produces it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

const required = [
  {
    path: path.resolve(appRoot, '..', 'web', 'dist', 'index.html'),
    produces: 'run `pnpm --filter @orbit/web build` (apps/web/dist)',
  },
  {
    path: path.resolve(appRoot, '..', '..', 'infra', 'compose', 'docker-compose.images.yml'),
    produces: 'the infra package (infra/compose/docker-compose.images.yml)',
  },
  {
    path: path.resolve(appRoot, '..', '..', 'infra', 'compose', '.env.images.example'),
    produces: 'the infra package (infra/compose/.env.images.example)',
  },
  {
    path: path.join(appRoot, 'dist', 'main.js'),
    produces: 'run `pnpm --filter @orbit/desktop build`',
  },
];

const missing = required.filter((entry) => !fs.existsSync(entry.path));
if (missing.length) {
  console.error('[desktop] cannot package: these paths are missing\n');
  for (const entry of missing) {
    console.error(`  ${path.relative(appRoot, entry.path)}`);
    console.error(`    produced by: ${entry.produces}`);
  }
  console.error('\nelectron-builder reads them in electron-builder.yml (extraResources).');
  process.exit(1);
}

console.log(`[desktop] packaging inputs present (${required.length} checked)`);

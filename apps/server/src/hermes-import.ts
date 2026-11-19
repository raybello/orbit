import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SHARED_CONFIG, SHARED_ENV, dotenvText, readDotenv, readYaml, writePrivate } from './hermes-files.js';

/** Written into the primary's home once an import has run; its presence means never again. */
export const IMPORT_MARKER = '.orbit-imported';

/** What the import may carry over: everything a copy cannot fork. */
const IMPORTED_FILES = ['SOUL.md', 'memories', 'skills'];

export type ImportResult = 'imported' | 'already-imported' | 'no-source';

/**
 * Seed the primary agent's home from a person's own Hermes home, once.
 *
 * Only what two agents can hold at the same time is copied: model keys (SHARED_ENV, so never a
 * Telegram or Discord token, which would make two agents answer one bot), the model config blocks
 * minus `mcp_servers` (those point at the person's own tools and app), the persona, memories and
 * skills. Never `auth.json` or an OAuth singleton file: Hermes refresh tokens are single-use, and a
 * copy strands one of the two holders with `invalid_grant` (see inheritSubscriptions in engine.ts).
 *
 * Anything the primary's home already has wins over the import, and the source is only read.
 */
export function importHostHermes(srcDir: string, primaryHome: string): ImportResult {
  const marker = path.join(primaryHome, IMPORT_MARKER);
  if (fs.existsSync(marker)) return 'already-imported';
  if (!fs.existsSync(path.join(srcDir, '.env')) && !fs.existsSync(path.join(srcDir, 'config.yaml'))) return 'no-source';
  fs.mkdirSync(primaryHome, { recursive: true });

  const srcEnv = readDotenv(path.join(srcDir, '.env'));
  const envFile = path.join(primaryHome, '.env');
  const vars = readDotenv(envFile);
  for (const k of SHARED_ENV) if (srcEnv[k]?.trim() && !vars[k]) vars[k] = srcEnv[k];
  if (Object.keys(vars).length) writePrivate(envFile, dotenvText(vars));

  const srcCfg = readYaml(path.join(srcDir, 'config.yaml'));
  const cfgFile = path.join(primaryHome, 'config.yaml');
  const cfg = readYaml(cfgFile);
  for (const k of SHARED_CONFIG) {
    if (k === 'mcp_servers' || srcCfg[k] === undefined || srcCfg[k] === null) continue;
    if (!Object.prototype.hasOwnProperty.call(cfg, k)) cfg[k] = srcCfg[k];
  }
  if (Object.keys(cfg).length) writePrivate(cfgFile, YAML.stringify(cfg));

  for (const name of IMPORTED_FILES) {
    const from = path.join(srcDir, name);
    if (!fs.existsSync(from)) continue;
    // Links are followed: one pointing back into the source would dangle where the import lands.
    fs.cpSync(from, path.join(primaryHome, name), { recursive: true, force: false, errorOnExist: false, dereference: true });
  }

  writePrivate(marker, `${JSON.stringify({ from: srcDir, at: new Date().toISOString() })}\n`);
  return 'imported';
}

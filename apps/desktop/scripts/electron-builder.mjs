/**
 * Run electron-builder the way the release workflow does.
 *
 * With no CSC_LINK/CSC_NAME, electron-builder still auto-discovers any signing identity in the
 * login keychain. On a developer's Mac that is usually an "Apple Development" certificate, which
 * is not for distribution: macOS blocks the result as malware and moves it to the Trash. Turning
 * discovery off leaves the ad-hoc signature from after-pack.cjs, exactly what CI ships. A real
 * Developer ID (CSC_LINK or CSC_NAME) is still used when one is given.
 *
 *   node scripts/electron-builder.mjs [electron-builder args…]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const env = { ...process.env };
if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(result.status ?? 1);

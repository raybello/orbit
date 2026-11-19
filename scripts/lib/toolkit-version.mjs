// The Google toolkit version the server pins, read from its one declaration so scripts never drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/server/src/domain/google-actions.ts');
const match = /export const GOOGLE_TOOLKIT_VERSION = '([^']+)'/.exec(fs.readFileSync(source, 'utf8'));
if (!match) throw new Error(`GOOGLE_TOOLKIT_VERSION not found in ${source}`);

export const GOOGLE_TOOLKIT_VERSION = match[1];

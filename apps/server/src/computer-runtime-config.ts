import { db } from './db.js';
import { env } from './env.js';

/**
 * Which runtime runs bot computers, as chosen in Settings. The choice is stored with the app's data
 * (not an environment variable) so a person can move between Docker and Apple's container without
 * editing files; with nothing stored, COMPUTER_RUNTIME / auto-detection decides (env.ts).
 */

export type RuntimeName = 'docker' | 'apple';

db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const KEY = 'computer_runtime';

export function preferredRuntime(): RuntimeName | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(KEY) as { value?: string } | undefined;
  return row?.value === 'docker' || row?.value === 'apple' ? row.value : null;
}

export function setPreferredRuntime(name: RuntimeName | null): void {
  if (name === null) db.prepare('DELETE FROM app_settings WHERE key=?').run(KEY);
  else db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, name);
}

export function activeRuntimeName(): RuntimeName {
  return preferredRuntime() ?? env.computerRuntime;
}

/**
 * The main process's console, mirrored to a file.
 *
 * A packaged app launched from Finder or the Start menu has no terminal, so without this every
 * `[orbit:*]` line is lost and a failed first run leaves nothing to look at. One file, one
 * rotation: when it passes `maxBytes` at startup it becomes `main.old.log`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

export const LOG_FILE_NAME = 'main.log';
const MAX_BYTES = 5 * 1024 * 1024;

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
const METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error'];

export function installLogFile(dir: string, opts: { maxBytes?: number; target?: Pick<Console, ConsoleMethod> } = {}): string {
  const file = path.join(dir, LOG_FILE_NAME);
  const target = opts.target ?? console;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > (opts.maxBytes ?? MAX_BYTES)) {
      fs.renameSync(file, path.join(dir, 'main.old.log'));
    }
  } catch {
    return file;
  }

  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      original(...args);
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${format(...args)}\n`);
      } catch {
        /* a full disk must not take logging, or the app, down */
      }
    };
  }
  return file;
}

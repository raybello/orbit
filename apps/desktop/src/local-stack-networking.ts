/**
 * The two little files the rest of the app reads instead of parsing `.env`.
 *
 * The stack dir is user-owned and may be edited by hand, so reads are defensive: a
 * missing or unreadable file falls back rather than throwing during startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_LOCAL_WEB_URL } from './setup-config';

const WEB_URL_FILE = '.orbit-web-url';
const STACK_TOKEN_FILE = '.orbit-stack-token';

function writePrivate(file: string, value: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: mode is advisory */
  }
}

function readTrimmed(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

export function writeStackWebUrl(dir: string, url: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, WEB_URL_FILE), `${url}\n`, 'utf8');
}

export function readStackWebUrl(dir: string, fallback: string = DEFAULT_LOCAL_WEB_URL): string {
  return readTrimmed(path.join(dir, WEB_URL_FILE)) ?? fallback;
}

export function writeStackToken(dir: string, token: string): void {
  writePrivate(path.join(dir, STACK_TOKEN_FILE), token);
}

export function readStackToken(dir: string): string | null {
  return readTrimmed(path.join(dir, STACK_TOKEN_FILE));
}

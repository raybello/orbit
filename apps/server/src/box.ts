import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import type { Secret } from './lib/secret-box.js';

/**
 * The box: where shell commands run. A bot's desktop commands run inside its own Docker container
 * (docker/docker-box.ts); the server's own work (the Library on its disk) runs here. Both speak
 * the same small interface, so the desk scripts (desk.ts) do not care which one they talk to.
 */

export interface BashResult { output: string; exit_code: number }

export interface Box {
  /** Run a bash command on the box. `screenId` picks which screen's DISPLAY it sees. */
  bash(command: string, timeoutSec?: number, screenId?: string | null): Promise<BashResult>;
  /** Write a file, creating its directory. `mode` is an octal string such as '0755'. */
  writeFile(file: string, content: string | Buffer, mode?: string): Promise<void>;
  /** Read a file, or null if it is not there. Meant for small files. */
  readFile(file: string): Promise<Buffer | null>;
  /**
   * Type a secret into whatever has focus on that screen. Unlike `bash`, the value is never part of a
   * command line: it would sit in the process list, in Docker's record of the exec, or in the
   * provider's log of the command for as long as those are kept.
   */
  typeSecret(secret: Secret, screenId?: string | null): Promise<void>;
  /** A path safe to put inside single quotes in a shell command. */
  quote(s: string): string;
}

/** xdotool typing what it reads on stdin, so the text is in no argument. */
export const TYPE_FROM_STDIN = ['xdotool', 'type', '--clearmodifiers', '--delay', '12', '--file', '-'];

/** Screen id -> X display. The default screen is :99, "screen-100" is :100. */
export const displayFor = (screenId?: string | null) => (!screenId || screenId === 'default' ? ':99' : `:${screenId.replace('screen-', '')}`);

/** Only what a desktop command needs; none of this server's secrets. */
function shellEnv(screenId?: string | null): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: process.env.HOME ?? '/root',
    USER: process.env.USER ?? 'root',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DISPLAY: displayFor(screenId),
  };
}

function localBash(command: string, timeoutSec: number, screenId?: string | null): Promise<BashResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], { timeout: timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, env: shellEnv(screenId) }, (err, stdout, stderr) => {
      // `code` is the exit status when the process ran, or an errno string when it could not start.
      const failure = err as { code?: unknown } | null;
      const code = err ? (typeof failure?.code === 'number' ? failure.code : 1) : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
    });
  });
}

function localTypeSecret(secret: Secret, screenId?: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(TYPE_FROM_STDIN[0], TYPE_FROM_STDIN.slice(1), { env: shellEnv(screenId), stdio: ['pipe', 'ignore', 'pipe'], timeout: 60_000 });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => reject(new Error(`could not type on this computer: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(secret.redact(`typing failed (exit ${code}): ${stderr.trim().slice(-200)}`)));
    });
    // xdotool exiting early closes the pipe under the write; the exit code above is the report.
    child.stdin.on('error', () => {});
    child.stdin.end(secret.reveal());
  });
}

/** A path safe to put inside single quotes in a shell command. */
export const quotePath = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const q = quotePath;

/** A box on this machine (HQ_LOCAL=1). */
function localBox(): Box {
  return {
    bash: (command, timeoutSec = 60, screenId) => localBash(command, timeoutSec, screenId),
    async writeFile(file, content, mode = '0644') {
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buf);
      await fs.chmod(file, parseInt(mode, 8));
    },
    async readFile(file) {
      try { return await fs.readFile(file); } catch { return null; }
    },
    typeSecret: localTypeSecret,
    quote: q,
  };
}

/**
 * The box this server works on by default: its own shell and disk, where the Library lives. Bots
 * never use this one for their own work: each has a container with a box of its own.
 */
export const box: Box = localBox();

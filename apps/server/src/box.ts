import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { orgo } from './orgo.js';
import { dockerBox } from './docker/docker-box.js';

/**
 * The box: where a bot's desktop commands run. The primary bot works on the one Orgo computer
 * (or on this machine when HQ_LOCAL=1); a managed bot works inside its own Docker container.
 * Everything here speaks the same small interface, so the desk scripts (desk.ts) do not care
 * which one they are talking to.
 */

export interface BashResult { output: string; exit_code: number }

export interface Box {
  /** True when this box is the machine the server itself runs on. */
  local: boolean;
  /** Run a bash command on the box. `screenId` picks which screen's DISPLAY it sees. */
  bash(command: string, timeoutSec?: number, screenId?: string | null): Promise<BashResult>;
  /** Write a file, creating its directory. `mode` is an octal string such as '0755'. */
  writeFile(file: string, content: string | Buffer, mode?: string): Promise<void>;
  /** Read a file, or null if it is not there. Meant for small files. */
  readFile(file: string): Promise<Buffer | null>;
  /** A path safe to put inside single quotes in a shell command. */
  quote(s: string): string;
}

/** Which computer a box talks to. */
export type BoxTarget =
  | { kind: 'local' }
  | { kind: 'orgo'; computerId: string }
  | { kind: 'docker'; containerId: string };

/** Orgo screen id -> X display. The default screen is :99, "screen-100" is :100. */
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
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ output: `${stdout ?? ''}${stderr ?? ''}`, exit_code: code });
    });
  });
}

/** A path safe to put inside single quotes in a shell command. */
export const quotePath = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const q = quotePath;

/** A box on this machine (HQ_LOCAL=1). */
function localBox(): Box {
  return {
    local: true,
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
    quote: q,
  };
}

/** A box on one Orgo computer, through Orgo's API. */
export function orgoBox(computerId: string): Box {
  const b: Box = {
    local: false,
    async bash(command, timeoutSec = 60, screenId) {
      const cmd = `export DISPLAY=${displayFor(screenId)}; ${command}`;
      const r = await orgo.bash(computerId, screenId ?? undefined, cmd, timeoutSec);
      return { output: r.output ?? '', exit_code: r.exit_code ?? (r.success ? 0 : 1) };
    },
    async writeFile(file, content, mode = '0644') {
      // Orgo drops very long commands, so the file goes over in base64 pieces.
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      const b64 = buf.toString('base64');
      const tmp = `${file}.b64`;
      const first = await b.bash(`mkdir -p ${q(path.dirname(file))} && : > ${q(tmp)} && echo ok`, 30);
      if (!first.output.includes('ok')) throw new Error(`could not write ${file}: ${first.output.slice(0, 200)}`);
      for (let i = 0; i < b64.length; i += 60000) await b.bash(`printf '%s' '${b64.slice(i, i + 60000)}' >> ${q(tmp)}`, 30);
      const done = await b.bash(`base64 -d ${q(tmp)} > ${q(file)} && rm -f ${q(tmp)} && chmod ${mode} ${q(file)} && echo ok`, 30);
      if (!done.output.includes('ok')) throw new Error(`could not write ${file}: ${done.output.slice(0, 200)}`);
    },
    async readFile(file) {
      const r = await b.bash(`[ -f ${q(file)} ] && base64 -w0 ${q(file)} || echo __missing__`, 60);
      const out = r.output.trim();
      if (!out || out.endsWith('__missing__')) return null;
      return Buffer.from(out, 'base64');
    },
    quote: q,
  };
  return b;
}

/** Build a box bound to a specific computer. */
export function boxFor(target: BoxTarget): Box {
  if (target.kind === 'docker') return dockerBox(target.containerId);
  if (target.kind === 'orgo') return orgoBox(target.computerId);
  return localBox();
}

/**
 * The box this server works on by default: the local shell when the server runs on the computer,
 * else the shared Orgo computer. Managed bots never use this one — they get a box of their own.
 */
export const box: Box = env.localBox
  ? localBox()
  : {
      local: false,
      async bash(command, timeoutSec = 60, screenId) {
        // Orgo path; resolved lazily so a missing ORGO_COMPUTER_ID only fails when used.
        if (!env.orgoComputerId) throw new Error('ORGO_COMPUTER_ID is not set');
        return orgoBox(env.orgoComputerId).bash(command, timeoutSec, screenId);
      },
      async writeFile(file, content, mode = '0644') {
        if (!env.orgoComputerId) throw new Error('ORGO_COMPUTER_ID is not set');
        return orgoBox(env.orgoComputerId).writeFile(file, content, mode);
      },
      async readFile(file) {
        if (!env.orgoComputerId) throw new Error('ORGO_COMPUTER_ID is not set');
        return orgoBox(env.orgoComputerId).readFile(file);
      },
      quote: q,
    };

// The global box above satisfies the Box interface for desk.ts; managed bots get a box of their own.

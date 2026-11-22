import { spawn } from 'node:child_process';
import { appleContainerBinary } from '../env.js';

/** Thin wrapper over Apple's `container` CLI: run it, capture stdout and stderr, never throw on a non-zero exit. */

export interface CliResult { stdout: string; stderr: string; code: number }

export interface CliOptions {
  input?: Buffer;
  /** Kill the CLI after this long (it reports code 124). 0 = no limit. */
  timeoutMs?: number;
  /** Called with each line of output, for long commands (build, pull). */
  onLine?: (line: string) => void;
}

export class AppleRuntimeMissing extends Error {
  constructor() {
    super("Apple's container runtime is not installed. Install it from Orbit's setup (or `brew install container`), then open the bot again.");
    this.name = 'AppleRuntimeMissing';
  }
}

export function containerBinary(): string {
  const bin = appleContainerBinary();
  if (!bin) throw new AppleRuntimeMissing();
  return bin;
}

export function runContainer(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    let bin: string;
    try {
      bin = containerBinary();
    } catch (e) {
      return reject(e);
    }
    const child = spawn(bin, args, { stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    let partial = '';
    const feed = (chunk: Buffer) => {
      if (!opts.onLine) return;
      partial += chunk.toString('utf8');
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) opts.onLine(line);
    };
    child.stdout!.on('data', (d: Buffer) => { out.push(d); feed(d); });
    child.stderr!.on('data', (d: Buffer) => { err.push(d); feed(d); });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (partial.trim()) opts.onLine?.(partial);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        code: timedOut ? 124 : (code ?? 1),
      });
    });
    if (opts.input !== undefined) {
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(opts.input);
    }
  });
}

/** The CLI's message for a failure, trimmed to something worth showing. */
export function cliMessage(r: CliResult): string {
  return (r.stderr || r.stdout).trim().replace(/\s+/g, ' ').slice(0, 400);
}

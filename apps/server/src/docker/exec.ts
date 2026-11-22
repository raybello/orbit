import { runtime } from './runtime.js';
import type { ExecResult } from './runtime-types.js';

/**
 * Running commands inside a bot's container, whichever runtime made it. The runtime owns how a
 * command is delivered (Docker's exec API, or `container exec`); this is what the screens and the
 * desk's box call.
 */

export type { ExecResult };

/**
 * Run a command inside the container. With `timeoutMs` the command runs under coreutils `timeout`
 * so a stuck desktop tool cannot hold the request forever (exit code 124 means it ran out).
 *
 * `stdin` is how a value reaches the command without being part of `cmd`: an exec's command line is
 * kept by the runtime and shows in the container's process list, while what is written to stdin is
 * in neither.
 */
export function execInContainer(
  containerId: string,
  cmd: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
  stdin?: Buffer,
): Promise<ExecResult> {
  return runtime().exec(containerId, cmd, env, timeoutMs, stdin);
}

export async function writeFileInContainer(
  containerId: string,
  target: string,
  content: Buffer,
  mode = '0644',
): Promise<void> {
  const script = [
    'import os, sys',
    'target = sys.argv[1]',
    'os.makedirs(os.path.dirname(target), exist_ok=True)',
    "data = sys.stdin.buffer.read()",
    "with open(target, 'wb') as f: f.write(data)",
    'os.chmod(target, int(sys.argv[2], 8))',
  ].join('\n');
  const r = await execInContainer(containerId, ['python3', '-c', script, target, mode], {}, 60_000, content);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || `could not write ${target}`);
}

/**
 * Run a multi-line shell script from a file inside the container. It matters that the script is a
 * file rather than the body of `bash -c`: pkill -f patterns in it would otherwise match the shell
 * running them, and the script would kill itself.
 */
export async function runScript(
  containerId: string,
  name: string,
  body: string,
  timeoutMs = 60_000,
): Promise<ExecResult> {
  const path = `/tmp/orbit-${name.replace(/[^a-z0-9_-]/gi, '_')}.sh`;
  await writeFileInContainer(containerId, path, Buffer.from(body, 'utf8'), '0755');
  return execInContainer(containerId, ['bash', path], {}, timeoutMs);
}

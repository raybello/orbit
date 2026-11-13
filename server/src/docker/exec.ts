import { docker } from './client.js';

/**
 * Running commands inside a bot's container. Docker answers an attached exec with a stream of
 * multiplexed frames (8-byte header: type, padding, big-endian length), one stream for stdout
 * (type 1) and stderr (type 2).
 */

async function container(containerId: string) {
  const c = docker().getContainer(containerId);
  // Fail with Docker's own "no such container" instead of a confusing 404 later on.
  await c.inspect();
  return c;
}

/** Split a multiplexed Docker stream into stdout and stderr text. */
export function demuxOutput(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = start + len;
    if (end > buf.length) break; // a truncated frame: keep what is complete
    (type === 2 ? err : out).push(buf.subarray(start, end));
    i = end;
  }
  // A stream without frame headers (a TTY container) is plain text.
  if (i === 0 && buf.length) out.push(buf);
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

export interface ExecResult { stdout: string; stderr: string; code: number }

/**
 * Run a command inside the container. With `timeoutMs` the command runs under coreutils `timeout`
 * so a stuck desktop tool cannot hold the request forever (exit code 124 means it ran out).
 */
export async function execInContainer(
  containerId: string,
  cmd: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<ExecResult> {
  const c = await container(containerId);
  const argv = timeoutMs > 0
    ? ['timeout', '-k', '5', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...cmd]
    : cmd;
  const exec = await c.exec({
    Cmd: argv,
    AttachStdout: true,
    AttachStderr: true,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    WorkingDir: '/home/bot',
  });
  const stream = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer | string) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const output = demuxOutput(Buffer.concat(chunks));
  const inspect = await exec.inspect();
  return { stdout: output.stdout, stderr: output.stderr, code: inspect.ExitCode ?? 0 };
}

/** Run a command and stream its output as it comes (long uploads, log tails). */
export async function execStreaming(
  containerId: string,
  cmd: string[],
  onChunk: (chunk: { stream: 'stdout' | 'stderr'; data: string }) => void,
): Promise<number> {
  const c = await container(containerId);
  const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, WorkingDir: '/home/bot' });
  const stream = (await exec.start({ hijack: true, stdin: false })) as NodeJS.ReadableStream;
  // Reuse the demuxer one frame at a time by buffering only a partial frame between chunks.
  let pending = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (data: Buffer | string) => {
      pending = Buffer.concat([pending, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      while (pending.length >= 8) {
        const type = pending[0];
        const len = pending.readUInt32BE(4);
        if (pending.length < 8 + len) break;
        const text = pending.subarray(8, 8 + len).toString('utf8');
        pending = pending.subarray(8 + len);
        if (text) onChunk({ stream: type === 2 ? 'stderr' : 'stdout', data: text });
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const inspect = await exec.inspect();
  return inspect.ExitCode ?? 0;
}

/** Write a file inside the container by streaming it to a small python writer. */
export async function writeFileInContainer(
  containerId: string,
  target: string,
  content: Buffer,
  mode = '0644',
): Promise<void> {
  const c = await container(containerId);
  const script = [
    'import os, sys',
    'target = sys.argv[1]',
    'os.makedirs(os.path.dirname(target), exist_ok=True)',
    "data = sys.stdin.buffer.read()",
    "with open(target, 'wb') as f: f.write(data)",
    'os.chmod(target, int(sys.argv[2], 8))',
  ].join('\n');
  const exec = await c.exec({
    Cmd: ['python3', '-c', script, target, mode],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: '/home/bot',
  });
  const stream = (await exec.start({ hijack: true, stdin: true })) as NodeJS.WritableStream & NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer | string) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  stream.write(content);
  stream.end();
  await done;
  const inspect = await exec.inspect();
  if ((inspect.ExitCode ?? 0) !== 0) {
    const out = demuxOutput(Buffer.concat(chunks));
    throw new Error(out.stderr || out.stdout || `could not write ${target}`);
  }
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

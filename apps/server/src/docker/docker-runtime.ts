import { docker, dockerProblem, type DockerError } from './client.js';
import {
  containerStatus, createBotContainer, dockerHostMemory, liveBotContainers, pauseContainer, removeContainer, reservationBytes,
  startContainer, stopContainer, unpauseContainer,
} from './container.js';
import { demuxOutput } from './demux.js';
import { ensureBotOnNetwork, screenEndpointFor, serverPlacement } from './reach.js';
import { withTimeout, type ContainerRuntime, type ExecResult } from './runtime-types.js';

/** The Docker Engine API as a bot-computer runtime: a thin adapter over container.ts and reach.ts. */

async function dockerExec(
  containerId: string,
  cmd: string[],
  env: Record<string, string>,
  timeoutMs: number,
  stdin?: Buffer,
): Promise<ExecResult> {
  const c = docker().getContainer(containerId);
  // Fail with Docker's own "no such container" instead of a confusing 404 later on.
  await c.inspect();
  // `stdin` is how a value reaches the command without being part of `cmd`: Docker keeps an exec's
  // command line (exec inspect, the daemon's events) and the container's process list shows it,
  // while what is written to stdin is in neither.
  const piped = stdin !== undefined;
  const exec = await c.exec({
    Cmd: withTimeout(cmd, timeoutMs),
    AttachStdin: piped,
    AttachStdout: true,
    AttachStderr: true,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    WorkingDir: '/home/bot',
  });
  const stream = (await exec.start({ hijack: true, stdin: piped })) as NodeJS.ReadableStream & NodeJS.WritableStream;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d: Buffer | string) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end', resolve);
    stream.on('error', reject);
    if (piped) {
      stream.write(stdin);
      stream.end();
    }
  });
  const output = demuxOutput(Buffer.concat(chunks));
  const inspect = await exec.inspect();
  return { stdout: output.stdout, stderr: output.stderr, code: inspect.ExitCode ?? 0 };
}

export const dockerRuntime: ContainerRuntime = {
  name: 'docker',
  async create(spec) {
    const id = await createBotContainer(spec);
    // A container found by its label may be one a previous run left stopped.
    if (!(await containerStatus(id)).running) await startContainer(id);
    return id;
  },
  start: startContainer,
  stop: stopContainer,
  remove: removeContainer,
  status: containerStatus,
  pause: pauseContainer,
  unpause: unpauseContainer,
  exec: dockerExec,
  endpoint: screenEndpointFor,
  async ensureReachable(containerId) {
    // A bot's screen is dialed over the Docker network the server shares with it (a containerized
    // server) or over published loopback ports (a server on the host). A container made before the
    // server moved into a container sits on the default bridge, so it joins the server's network.
    const placement = await serverPlacement();
    if (!placement.inContainer || !placement.network) return;
    try {
      if (await ensureBotOnNetwork(containerId, placement.network)) {
        console.log(`[docker] ${containerId.slice(0, 12)} joined ${placement.network} so its screen is reachable from the server's container`);
      }
    } catch (e) {
      console.warn(`[docker] could not put ${containerId.slice(0, 12)} on ${placement.network}: ${String((e as DockerError)?.message ?? e)}`);
    }
  },
  reservation: () => reservationBytes(),
  hostMemory: dockerHostMemory,
  liveBots: liveBotContainers,
  problem: dockerProblem,
};

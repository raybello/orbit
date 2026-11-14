import type Docker from 'dockerode';
import { env } from '../env.js';
import { docker } from './client.js';
import { COMPUTER_IMAGE, ensureComputerImage } from './image.js';
import { cdpBridgePort, screenPorts } from './screen.js';

/**
 * One container per managed bot. Each is a small Linux desktop (Xvfb + x11vnc + a browser) whose
 * /home/bot is a host folder, so a stopped container keeps everything that matters on the host.
 */

export interface ContainerSpec {
  botId: string;
  homePath: string;
  /** Display index claimed for the bot's first screen; fixes which ports are published. */
  displayIndex: number;
  timezone?: string;
  language?: string;
}

function sanitize(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
  return safe || 'bot';
}

export function containerNameFor(botId: string): string {
  return `orbit-bot-${sanitize(botId)}`;
}

/** Docker-style size ("2g", "1536m", "1073741824") to bytes. */
export function memoryBytes(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!m) throw new Error(`COMPUTER_MEMORY_LIMIT must be a size like "2g" or "1536m", got "${raw}"`);
  const scale = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase() as 'b' | 'k' | 'm' | 'g'];
  const bytes = Math.floor(Number(m[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes < 6 * 1024 ** 2) {
    throw new Error(`COMPUTER_MEMORY_LIMIT must be at least 6m (Docker's minimum), got "${raw}"`);
  }
  return bytes;
}

/** Docker create options for a bot's computer. */
export function containerCreateOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
  const ports = screenPorts(spec.displayIndex);
  const memory = memoryBytes(env.computerMemoryLimit);
  // VNC is one host port to the same container port; DevTools goes through the container's socat
  // bridge (see screen.ts), so its container port differs from the host port.
  const exposed: Record<string, object> = {
    [`${ports.vncPort}/tcp`]: {},
    [`${cdpBridgePort(spec.displayIndex)}/tcp`]: {},
  };
  const bindings = {
    [`${ports.vncPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(ports.vncPort) }],
    [`${cdpBridgePort(spec.displayIndex)}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(ports.cdpPort) }],
  };
  return {
    Image: COMPUTER_IMAGE,
    name: containerNameFor(spec.botId),
    Tty: false,
    WorkingDir: '/home/bot',
    Labels: { 'orbit.managed': 'true', 'orbit.botId': spec.botId },
    Env: [
      'HOME=/home/bot',
      'USER=root',
      'LANG=C.UTF-8',
      `TZ=${spec.timezone ?? process.env.TZ ?? 'UTC'}`,
      `LANGUAGE=${spec.language ?? 'en_US'}`,
      `DISPLAY=${ports.display}`,
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      // The desk scripts keep Chrome profiles and logs under these (hqlib reads them).
      'HQ_PROFILES=/home/bot/.local/share/grokbot/profiles',
      'HQ_LOGS=/home/bot/.local/share/hq/logs',
      'NO_AT_BRIDGE=1',
    ],
    ExposedPorts: exposed,
    HostConfig: {
      Binds: [`${spec.homePath}:/home/bot`],
      PortBindings: bindings,
      ShmSize: 512 * 1024 * 1024,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.floor(env.computerCpuLimit * 1e9),
      PidsLimit: 2048,
      AutoRemove: false,
      NetworkMode: env.computerNetwork,
      RestartPolicy: { Name: 'no' },
    },
  };
}

/** Create and start a container for a bot. Returns its id. */
export async function createBotContainer(spec: ContainerSpec): Promise<string> {
  await ensureComputerImage();
  const existing = await findBotContainer(spec.botId);
  if (existing) return existing.id;
  const c = await docker().createContainer(containerCreateOptions(spec));
  await c.start();
  return c.id;
}

export async function startContainer(containerId: string): Promise<void> {
  await docker().getContainer(containerId).start();
}

/** Stop a container gracefully, then kill it if it will not go. */
export async function stopContainer(containerId: string): Promise<void> {
  try {
    await docker().getContainer(containerId).stop({ t: 10 });
  } catch (e: any) {
    if (e?.statusCode === 404) return; // already gone
    throw e;
  }
}

/** Remove a container (stopping it first when it still runs). */
export async function removeContainer(containerId: string): Promise<void> {
  try {
    const c = docker().getContainer(containerId);
    const info = await c.inspect();
    if (info.State?.Running) await c.stop({ t: 10 }).catch(() => undefined);
    await c.remove({ force: true });
  } catch (e: any) {
    if (e?.statusCode === 404) return;
    throw e;
  }
}

/** The bot's container, or null. Matches on the label so a renamed container is still found. */
export async function findBotContainer(botId: string): Promise<Docker.Container | null> {
  const list = await docker().listContainers({ all: true, filters: { label: [`orbit.botId=${botId}`] } });
  const hit = list.find((c) => (c.Labels ?? {})['orbit.botId'] === botId);
  return hit ? docker().getContainer(hit.Id) : null;
}

export interface ContainerStatus {
  exists: boolean;
  running: boolean;
  status?: string;
}

export async function containerStatus(containerId: string): Promise<ContainerStatus> {
  try {
    const info = await docker().getContainer(containerId).inspect();
    return { exists: true, running: Boolean(info.State?.Running), status: info.State?.Status };
  } catch (e: any) {
    if (e?.statusCode === 404) return { exists: false, running: false };
    throw e;
  }
}

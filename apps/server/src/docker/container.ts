import type Docker from 'dockerode';
import { env } from '../env.js';
import { docker, type DockerError } from './client.js';
import { COMPUTER_IMAGE, ensureComputerImage } from './image.js';
import { cdpBridgePort, screenPorts } from './screen.js';
import { botNetworkName, extraNetworksFor, serverPlacement } from './reach.js';

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
  /**
   * Docker network the container joins. A containerized server passes its own network so it can
   * dial the screen (see reach.ts); otherwise this is COMPUTER_NETWORK/bridge.
   */
  network?: string;
  /** Further networks to join, on top of `network` (a pinned COMPUTER_NETWORK plus the server's own). */
  extraNetworks?: string[];
  /**
   * Publish the VNC/DevTools ports on 127.0.0.1. A server running in a container dials the bot over
   * the shared Docker network instead, and publishing there only invites host-port collisions
   * between stacks.
   */
  publishPorts?: boolean;
}

function sanitize(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
  return safe || 'bot';
}

export function containerNameFor(botId: string): string {
  return `orbit-bot-${sanitize(botId)}`;
}

/** Docker-style size ("2g", "1536m", "1073741824") to bytes. */
export function memoryBytes(raw: string, name = 'COMPUTER_MEMORY_LIMIT'): number {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg])?b?$/i.exec(raw.trim());
  if (!m) throw new Error(`${name} must be a size like "2g" or "1536m", got "${raw}"`);
  const scale = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase() as 'b' | 'k' | 'm' | 'g'];
  const bytes = Math.floor(Number(m[1]) * scale);
  if (!Number.isSafeInteger(bytes) || bytes < 6 * 1024 ** 2) {
    throw new Error(`${name} must be at least 6m (Docker's minimum), got "${raw}"`);
  }
  return bytes;
}

/**
 * The soft limit one running bot is counted at, in bytes; 0 when the check is off ("0" or empty).
 * Never above the hard limit: Docker refuses a reservation larger than the limit.
 */
export function reservationBytes(raw = env.computerMemoryReservation, limit = memoryBytes(env.computerMemoryLimit)): number {
  const v = (raw ?? '').trim();
  if (!v || v === '0') return 0;
  return Math.min(memoryBytes(v, 'COMPUTER_MEMORY_RESERVATION'), limit);
}

/**
 * Chromium's switches for a bot's browser live in box/hqlib.py; this tells it to use the lean set
 * (fewer renderer processes, no background services). Containers set it, the shared computer does not.
 */
export const LEAN_BROWSER_ENV = 'HQ_LEAN_BROWSER=1';

export function containerCreateOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
  const ports = screenPorts(spec.displayIndex);
  const memory = memoryBytes(env.computerMemoryLimit);
  const reservation = reservationBytes(env.computerMemoryReservation, memory);
  // VNC is one host port to the same container port; DevTools goes through the container's socat
  // bridge (see screen.ts), so its container port differs from the host port.
  const exposed: Record<string, object> = {
    [`${ports.vncPort}/tcp`]: {},
    [`${cdpBridgePort(spec.displayIndex)}/tcp`]: {},
  };
  // Loopback only, always: the screen is reachable from this machine and never from the LAN.
  //
  // A server that itself runs in a container does not need the host ports at all — it dials the bot
  // on the Docker network both share (see docker/reach.ts). Publishing them there would also mean a
  // second stack (or an older bot) holding "its" host port, and the container then refuses to start
  // with "Bind for 127.0.0.1:<port> failed: port is already allocated".
  const bindings = spec.publishPorts === false
    ? undefined
    : {
        [`${ports.vncPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(ports.vncPort) }],
        [`${cdpBridgePort(spec.displayIndex)}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(ports.cdpPort) }],
      };
  const network = spec.network ?? env.computerNetwork;
  const extraNetworks = (spec.extraNetworks ?? []).filter((n) => n && n !== network);
  const endpoints: Record<string, object> = { [network]: {} };
  for (const n of extraNetworks) endpoints[n] = {};
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
      LEAN_BROWSER_ENV,
    ],
    ExposedPorts: exposed,
    // Joining more than one network has to go through EndpointsConfig; NetworkMode alone only
    // names the first.
    ...(extraNetworks.length ? { NetworkingConfig: { EndpointsConfig: endpoints } } : {}),
    HostConfig: {
      Binds: [`${spec.homePath}:/home/bot`],
      ...(bindings ? { PortBindings: bindings } : {}),
      // Chrome runs with --disable-dev-shm-usage, so /dev/shm only holds X and font scratch.
      ShmSize: 256 * 1024 * 1024,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: memory,
      MemorySwap: memory,
      // The soft limit: under pressure the kernel reclaims a bot down to this before anything else.
      ...(reservation ? { MemoryReservation: reservation } : {}),
      NanoCpus: Math.floor(env.computerCpuLimit * 1e9),
      PidsLimit: 2048,
      AutoRemove: false,
      NetworkMode: network,
      RestartPolicy: { Name: 'no' },
    },
  };
}

export async function createBotContainer(spec: ContainerSpec): Promise<string> {
  await ensureComputerImage();
  const existing = await findBotContainer(spec.botId);
  if (existing) return existing.id;
  // A server inside a container has to be able to dial the screen, so the bot joins the server's
  // network (and any pinned COMPUTER_NETWORK) rather than the default bridge.
  const placement = await serverPlacement();
  const network = spec.network ?? botNetworkName(placement);
  const extraNetworks = spec.extraNetworks ?? extraNetworksFor(placement, network);
  const c = await docker().createContainer(
    containerCreateOptions({ ...spec, network, extraNetworks, publishPorts: !placement.inContainer }),
  );
  console.log(`[docker] ${spec.botId} joins network ${[network, ...extraNetworks].join(', ')}`);
  await c.start();
  return c.id;
}

export async function startContainer(containerId: string): Promise<void> {
  await docker().getContainer(containerId).start();
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    // A frozen container cannot run its own shutdown; thaw it first so the stop is a clean one.
    await unpauseContainer(containerId);
    await docker().getContainer(containerId).stop({ t: 10 });
  } catch (e) {
    if ((e as DockerError)?.statusCode === 404) return; // already gone
    throw e;
  }
}

export async function removeContainer(containerId: string): Promise<void> {
  try {
    const c = docker().getContainer(containerId);
    const info = await c.inspect();
    if (info.State?.Running) await c.stop({ t: 10 }).catch(() => undefined);
    await c.remove({ force: true });
  } catch (e) {
    if ((e as DockerError)?.statusCode === 404) return;
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
  /** True for a paused container too: its processes exist, they are only frozen. */
  running: boolean;
  paused?: boolean;
  status?: string;
}

/** Freeze every process in the container (cgroup freezer): no CPU, memory kept, instant resume. */
export async function pauseContainer(containerId: string): Promise<void> {
  const c = docker().getContainer(containerId);
  const info = await c.inspect();
  if (info.State?.Running && !info.State?.Paused) await c.pause();
}

/** Thaw a paused container; a no-op for one that is not paused or not there. */
export async function unpauseContainer(containerId: string): Promise<void> {
  try {
    const c = docker().getContainer(containerId);
    const info = await c.inspect();
    if (info.State?.Paused) await c.unpause();
  } catch (e) {
    if ((e as DockerError)?.statusCode === 404) return;
    throw e;
  }
}

/** Memory Docker's Linux host (the colima/Docker Desktop VM on a Mac) has in all, in bytes. */
export async function dockerHostMemory(): Promise<number> {
  const info = (await docker().info()) as { MemTotal?: number };
  return Number(info.MemTotal ?? 0);
}

/** Bot containers that hold memory right now (running or paused), with their bot ids. */
export async function liveBotContainers(): Promise<{ id: string; botId: string }[]> {
  const list = await docker().listContainers({ all: false, filters: { label: ['orbit.managed=true'] } });
  return list.map((c) => ({ id: c.Id, botId: (c.Labels ?? {})['orbit.botId'] ?? '' })).filter((c) => c.botId);
}

/**
 * Whether one more bot fits: every live bot is counted at its reservation, and a share of the
 * machine is kept for Docker itself and anything else running there.
 */
export function fitsAnother(input: { hostMemory: number; liveBots: number; reservation: number; headroom?: number }): boolean {
  if (!input.reservation || !input.hostMemory) return true;
  const headroom = input.headroom ?? Math.max(512 * 1024 ** 2, Math.floor(input.hostMemory * 0.1));
  return (input.liveBots + 1) * input.reservation <= input.hostMemory - headroom;
}

export async function containerStatus(containerId: string): Promise<ContainerStatus> {
  try {
    const info = await docker().getContainer(containerId).inspect();
    return { exists: true, running: Boolean(info.State?.Running), paused: Boolean(info.State?.Paused), status: info.State?.Status };
  } catch (e) {
    if ((e as DockerError)?.statusCode === 404) return { exists: false, running: false };
    throw e;
  }
}

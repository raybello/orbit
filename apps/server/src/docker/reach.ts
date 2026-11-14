import fs from 'node:fs';
import os from 'node:os';
import { docker } from './client.js';
import { cdpBridgePort, screenPorts } from './screen.js';

/**
 * How the server reaches a bot's screen.
 *
 * On the host, a bot's VNC and DevTools ports are published on 127.0.0.1 and dialing those works.
 * Inside a container — which is how the desktop app ships the server — 127.0.0.1 is the *server's*
 * own loopback, and Docker's published ports live on the host, so nothing published is reachable.
 * The only route to a sibling container is a Docker network both containers are on, dialing the
 * bot's address there on the port it listens on inside the container.
 *
 * So: a containerized server attaches bot containers to its own network (the compose network it
 * was started on, unless COMPUTER_NETWORK pins another one) and dials the bot's container address;
 * a server on the host keeps using the loopback published ports. Nothing is ever published on a
 * non-loopback host interface either way.
 */

export interface ContainerNetwork { IPAddress?: string; NetworkID?: string; Gateway?: string }
export type ContainerNetworks = Record<string, ContainerNetwork>;

/** The parts of `docker inspect <container>` this module reasons about. */
export interface BotNetworkState {
  networks?: ContainerNetworks;
  /** Published ports, keyed "<port>/<proto>" (NetworkSettings.Ports). */
  ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
}

export interface ServerPlacement {
  /** The server itself runs in a container. */
  inContainer: boolean;
  /** The Docker network that container is on; bot containers must share it to be dialable. */
  network: string | null;
  /** Our own container id, when Docker confirms it. */
  containerId: string | null;
}

/** The server runs on the host: published loopback ports are the route. */
export const ON_HOST: ServerPlacement = { inContainer: false, network: null, containerId: null };

export type ScreenKind = 'vnc' | 'cdp';
export type ScreenTransport = 'network' | 'host-port';

export interface ScreenEndpoint {
  host: string;
  port: number;
  /**
   * 'network': the bot's address on a shared Docker network, on its container port.
   * 'host-port': 127.0.0.1 and the port Docker published there.
   */
  transport: ScreenTransport;
}

/** The bot's container is not on any network the server can dial it on. */
export class ScreenUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenUnreachableError';
  }
}

/**
 * The server's place, from an `inspect` of its own container (null when it is not in one). Docker
 * names a container's network; 'host' networking is the host's own namespace, so it keeps the
 * published-port route, and a network the server shares with bots is what matters.
 */
export function placementFromInspect(
  hostname: string,
  info: { Id?: string; NetworkSettings?: { Networks?: ContainerNetworks } } | null | undefined,
): ServerPlacement {
  if (!info) return ON_HOST;
  const names = Object.keys(info.NetworkSettings?.Networks ?? {});
  const usable = names.filter((n) => n !== 'host' && n !== 'none');
  // Prefer a user-defined (compose) network: the default bridge has no name resolution and is
  // shared with unrelated containers.
  const network = usable.find((n) => n !== 'bridge') ?? usable[0] ?? null;
  if (!network) return ON_HOST;
  return { inContainer: true, network, containerId: info.Id ?? hostname };
}

/** The port a screen listens on inside its own container. DevTools goes through socat (see screen.ts). */
export function screenContainerPort(kind: ScreenKind, index: number): number {
  return kind === 'vnc' ? screenPorts(index).vncPort : cdpBridgePort(index);
}

/** The port published on the host for a screen: VNC as-is, DevTools re-numbered 93xx -> 92xx. */
export function screenHostPort(kind: ScreenKind, index: number): number {
  const p = screenPorts(index);
  return kind === 'vnc' ? p.vncPort : p.cdpPort;
}

/**
 * The address to dial for one screen. Pure, so the choice can be tested against real inspect output
 * (a bot on the server's network, a bot stuck on the default bridge, a server on the host, a
 * server that publishes a non-default host port).
 */
export function resolveScreenEndpoint(opts: {
  placement: ServerPlacement;
  bot: BotNetworkState;
  index: number;
  kind: ScreenKind;
  /** COMPUTER_NETWORK, when an operator pinned a specific network for bot containers. */
  preferredNetwork?: string | null;
}): ScreenEndpoint {
  const { placement, bot, index, kind } = opts;

  if (placement.inContainer) {
    const candidates = [placement.network, opts.preferredNetwork ?? null].filter((n): n is string => Boolean(n));
    for (const name of candidates) {
      const ip = bot.networks?.[name]?.IPAddress;
      if (ip) return { host: ip, port: screenContainerPort(kind, index), transport: 'network' };
    }
    const on = Object.keys(bot.networks ?? {});
    throw new ScreenUnreachableError(
      `the bot's container is on ${on.length ? on.join(', ') : 'no Docker network'} but the server is on ` +
      `${placement.network ?? 'its own network'}; it cannot reach the screen. Open the bot again so the ` +
      'container is attached to the server\'s network.',
    );
  }

  // On the host, and always on 127.0.0.1 whatever HostIp Docker reports: the published binding is
  // loopback-only by construction (see container.ts), and this is the machine holding it.
  const published = bot.ports?.[`${screenContainerPort(kind, index)}/tcp`]?.[0];
  const hostPort = Number(published?.HostPort);
  return {
    host: '127.0.0.1',
    port: Number.isInteger(hostPort) && hostPort > 0 ? hostPort : screenHostPort(kind, index),
    transport: 'host-port',
  };
}

/** COMPUTER_NETWORK, when it is set at all (the pin is only meaningful if somebody wrote it). */
export function explicitNetwork(): string | null {
  const raw = (process.env.COMPUTER_NETWORK ?? '').trim();
  return raw || null;
}

/**
 * The network to create a bot container on. A containerized server has to be able to dial it, so
 * its own network is the default; COMPUTER_NETWORK still wins when set, and the container is then
 * also attached to the server's network (see extraNetworksFor) so the screen is reachable.
 */
export function botNetworkName(placement: ServerPlacement, explicit = explicitNetwork()): string {
  if (explicit) return explicit;
  if (placement.inContainer && placement.network) return placement.network;
  return 'bridge';
}

/** Further networks a new bot container joins so the server can reach it. */
export function extraNetworksFor(placement: ServerPlacement, primary: string): string[] {
  if (!placement.inContainer || !placement.network) return [];
  return placement.network === primary ? [] : [placement.network];
}

/** True when the process looks like it is inside a container rather than on the host. */
export function looksContainerized(hostname = process.env.HOSTNAME || os.hostname()): boolean {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch { /* not Linux */ }
  try {
    // cgroup v1 puts the container id in the path; v2 often has nothing, so it is only a hint.
    const cgroups = fs.readFileSync('/proc/self/cgroup', 'utf8');
    if (/docker|containerd|kubepods/.test(cgroups)) return true;
  } catch { /* not Linux */ }
  // Docker's default hostname for a container is the first 12 characters of its id.
  return /^[0-9a-f]{12}([0-9a-f]{52})?$/.test(hostname);
}

let placement: Promise<ServerPlacement> | null = null;

/** Where this server is, detected once: inside a container on its network, or on the host. */
export async function serverPlacement(): Promise<ServerPlacement> {
  if (!placement) placement = detectPlacement().catch(() => ON_HOST);
  return placement;
}

/** Forget the detection (a stack restart changes nothing, but tests and `reset` paths may). */
export function resetServerPlacement(): void {
  placement = null;
}

async function detectPlacement(): Promise<ServerPlacement> {
  const hostname = process.env.HOSTNAME || os.hostname();
  if (!looksContainerized(hostname)) return ON_HOST;
  try {
    const info = await docker().getContainer(hostname).inspect();
    return placementFromInspect(hostname, info);
  } catch (e: any) {
    console.warn(`[docker] looks containerized but its own container was not found (${e?.message ?? e}); ` +
      'screens will use published host ports');
    return ON_HOST;
  }
}

/** The bot container's networks and published ports, as Docker reports them. */
export async function botNetworkState(containerId: string): Promise<BotNetworkState> {
  const info = await docker().getContainer(containerId).inspect();
  return {
    networks: (info.NetworkSettings as any)?.Networks ?? {},
    ports: (info.NetworkSettings as any)?.Ports ?? {},
  };
}

/**
 * Put a bot container on `network`, if it is not there already. Containers made before this
 * existed (or by a host-run server) sit on the default bridge, which a containerized server cannot
 * route to. Returns true when this call attached it.
 */
export async function ensureBotOnNetwork(containerId: string, network: string): Promise<boolean> {
  const state = await botNetworkState(containerId);
  if (state.networks?.[network]?.IPAddress) return false;
  try {
    await docker().getNetwork(network).connect({ Container: containerId });
    return true;
  } catch (e: any) {
    const message = String(e?.message ?? e);
    // Another caller (or a concurrent boot) got there first.
    if (/already exists|already attached/i.test(message)) return false;
    if (e?.statusCode === 404) {
      throw new ScreenUnreachableError(`Docker network "${network}" does not exist, so a bot's screen cannot be reached on it`);
    }
    throw new ScreenUnreachableError(`could not attach the bot's container to network "${network}": ${message}`);
  }
}

/**
 * The endpoint for a screen, attaching the container to the server's network first when needed and
 * re-reading Docker's answer afterwards. This is the single place that maps display index +
 * container to a dialable address, so the relay and the browser's DevTools wiring agree.
 */
export async function screenEndpointFor(containerId: string, index: number, kind: ScreenKind): Promise<ScreenEndpoint> {
  const place = await serverPlacement();
  let bot = await botNetworkState(containerId);
  if (place.inContainer && place.network) {
    const wanted = [place.network, explicitNetwork()].filter((n): n is string => Boolean(n));
    for (const name of wanted) {
      if (bot.networks?.[name]?.IPAddress) continue;
      const attached = await ensureBotOnNetwork(containerId, name).catch((e) => {
        // A pinned network that is not ours is a fallback, not a requirement.
        if (name !== place.network) return false;
        throw e;
      });
      if (attached) {
        console.log(`[docker] attached ${containerId.slice(0, 12)} to network ${name}`);
        bot = await botNetworkState(containerId);
        break;
      }
    }
  }
  return resolveScreenEndpoint({ placement: place, bot, index, kind, preferredNetwork: explicitNetwork() });
}

/** A one-line description of the route, for logs and the screen's details panel. */
export function describeEndpoint(e: ScreenEndpoint): string {
  return `${e.host}:${e.port} (${e.transport})`;
}

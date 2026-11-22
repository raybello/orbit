import os from 'node:os';
import { containerNameFor, memoryBytes } from '../docker/container.js';
import { COMPUTER_IMAGE, IMAGE_CONTEXT, isRegistryImage } from '../docker/image.js';
import { ScreenUnreachableError, screenContainerPort, type ScreenEndpoint, type ScreenKind } from '../docker/reach.js';
import { LEAN_BROWSER_ENV } from '../docker/container.js';
import { screenPorts } from '../docker/ports.js';
import { withTimeout, type BotContainerSpec, type ContainerRuntime, type ContainerStatus, type ExecResult } from '../docker/runtime-types.js';
import { AppleRuntimeMissing, cliMessage, containerBinary, runContainer } from './cli.js';

/**
 * Apple's `container` as a bot-computer runtime. Each bot's computer is its own lightweight Linux VM
 * (macOS 26, Apple silicon) that runs the same image as the Docker path.
 *
 * Differences that matter here:
 *  - Every VM has its own address on the host's vmnet network, so the server dials the bot's IP on
 *    the ports it listens on and nothing is published on the host.
 *  - There is no pause. The idle policy is stop (after the home is checkpointed) and nothing else.
 *  - A VM keeps the memory it was given, so a bot is sized for Chromium up front (1.5 GB) and counted
 *    at that when deciding whether another fits.
 *  - Chromium has no GPU in a VM: HQ_VM_BROWSER=1 turns on the switches in box/hqlib.py that keep it
 *    off every GPU and compositor path, and /dev/shm is sized for X and font scratch.
 */

const MIB = 1024 ** 2;

/** A VM keeps the memory it was given, so Chromium's whole budget is set up front. */
export const APPLE_MEMORY_LIMIT = '1536m';

function memoryLimit(): number {
  return memoryBytes(process.env.COMPUTER_MEMORY_LIMIT?.trim() || APPLE_MEMORY_LIMIT);
}

/** `container`'s size argument: whole MiB. */
export function memoryArg(bytes: number): string {
  return `${Math.max(256, Math.floor(bytes / MIB))}M`;
}

/** A Chromium VM wants two vCPUs even when the per-bot limit is lower; the renderer and Xvfb share. */
export function cpuArg(limit: number): string {
  return String(Math.max(2, Math.ceil(limit || 1)));
}

export interface AppleCreateOptions {
  name: string;
  image: string;
  cpus: string;
  memory: string;
  timezone?: string;
  language?: string;
}

/** The argv for `container create`, pure so it can be pinned by a test. */
export function appleCreateArgs(spec: BotContainerSpec, opts: AppleCreateOptions): string[] {
  const ports = screenPorts(spec.displayIndex);
  const envList = [
    'HOME=/home/bot',
    'USER=root',
    'LANG=C.UTF-8',
    `TZ=${opts.timezone ?? process.env.TZ ?? 'UTC'}`,
    `LANGUAGE=${opts.language ?? 'en_US'}`,
    `DISPLAY=${ports.display}`,
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'HQ_PROFILES=/home/bot/.local/share/grokbot/profiles',
    'HQ_LOGS=/home/bot/.local/share/hq/logs',
    'NO_AT_BRIDGE=1',
    LEAN_BROWSER_ENV,
    'HQ_VM_BROWSER=1',
  ];
  const args = [
    'create',
    '--name', opts.name,
    '--label', 'orbit.managed=true',
    '--label', `orbit.botId=${spec.botId}`,
    '--cpus', opts.cpus,
    '--memory', opts.memory,
    '--cap-drop', 'ALL',
    '--shm-size', '256M',
    '--workdir', '/home/bot',
    '--volume', `${spec.homePath}:/home/bot`,
  ];
  for (const e of envList) args.push('--env', e);
  args.push(opts.image);
  return args;
}

/** `ipv4Address` is CIDR ("192.168.64.3/24"); the host dials the bare address. */
export function ipFromCidr(cidr: string | undefined): string | null {
  const ip = (cidr ?? '').split('/')[0]?.trim();
  return ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
}

export interface InspectedContainer {
  id: string;
  state: string;
  ip: string | null;
  labels: Record<string, string>;
}

/** What `container inspect` / `container ls --format json` print, reduced to what is used. */
export function parseInspect(json: string): InspectedContainer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: InspectedContainer[] = [];
  for (const item of list) {
    const c = item as {
      id?: string;
      configuration?: { id?: string; labels?: Record<string, string> };
      status?: { state?: string; networks?: { ipv4Address?: string }[] };
    };
    const id = c.id ?? c.configuration?.id;
    if (!id) continue;
    out.push({
      id,
      state: c.status?.state ?? 'unknown',
      ip: ipFromCidr(c.status?.networks?.[0]?.ipv4Address),
      labels: c.configuration?.labels ?? {},
    });
  }
  return out;
}

const NOT_FOUND = /not found|no such|does not exist/i;

async function inspect(id: string): Promise<InspectedContainer | null> {
  const r = await runContainer(['inspect', id]);
  if (r.code !== 0) {
    if (NOT_FOUND.test(`${r.stderr}${r.stdout}`)) return null;
    throw new Error(`container inspect ${id} failed: ${cliMessage(r)}`);
  }
  return parseInspect(r.stdout)[0] ?? null;
}

// ------------------------------------------------------------ the container system service

let systemReady: Promise<void> | null = null;

/** Whether the container apiserver answers. */
async function systemRunning(): Promise<boolean> {
  const r = await runContainer(['system', 'status'], { timeoutMs: 15_000 });
  return r.code === 0 && /status\s+running/i.test(r.stdout);
}

/**
 * The service is a launchd job that is off after a reboot until something starts it. Start it here,
 * once, without the interactive kernel prompt (the default kernel is the one Apple ships).
 */
export function ensureSystem(): Promise<void> {
  if (!systemReady) {
    systemReady = (async () => {
      if (await systemRunning()) return;
      console.log('[apple] starting the container system service');
      const r = await runContainer(['system', 'start', '--enable-kernel-install'], { timeoutMs: 300_000, onLine: (l) => console.log(`[apple] ${l}`) });
      if (r.code !== 0 && !(await systemRunning())) throw new Error(`could not start Apple's container service: ${cliMessage(r)}`);
    })().catch((e) => {
      systemReady = null;
      throw e;
    });
  }
  return systemReady;
}

// ------------------------------------------------------------ the image

let imageReady: Promise<void> | null = null;

async function imageExists(image: string): Promise<boolean> {
  if (!image.trim()) throw new Error('no computer image configured (COMPUTER_IMAGE is empty)');
  return (await runContainer(['image', 'inspect', image])).code === 0;
}

/** Pull a registry tag, or build an unqualified one from server/docker/computer (arm64, natively). */
export function ensureImage(): Promise<void> {
  if (!imageReady) {
    imageReady = (async () => {
      if (await imageExists(COMPUTER_IMAGE)) return;
      if (isRegistryImage(COMPUTER_IMAGE)) {
        console.log(`[apple] pulling ${COMPUTER_IMAGE}`);
        const r = await runContainer(['image', 'pull', COMPUTER_IMAGE], { onLine: (l) => console.log(`[apple] ${l}`) });
        if (r.code !== 0) throw new Error(`could not pull ${COMPUTER_IMAGE}: ${cliMessage(r)}`);
      } else {
        console.log(`[apple] building ${COMPUTER_IMAGE} from ${IMAGE_CONTEXT}`);
        const r = await runContainer(['build', '--tag', COMPUTER_IMAGE, IMAGE_CONTEXT], { onLine: (l) => console.log(`[apple] ${l}`) });
        // The builder is a 2 GB VM that stays up after a build; the image is all that is wanted.
        void runContainer(['builder', 'stop']).catch(() => undefined);
        if (r.code !== 0) throw new Error(`could not build ${COMPUTER_IMAGE}: ${cliMessage(r)}`);
      }
      if (!(await imageExists(COMPUTER_IMAGE))) throw new Error(`${COMPUTER_IMAGE} is still missing after pulling or building it`);
    })().catch((e) => {
      imageReady = null;
      throw e;
    });
  }
  return imageReady;
}

// ------------------------------------------------------------ the runtime

async function stop(id: string): Promise<void> {
  const r = await runContainer(['stop', '--time', '10', id], { timeoutMs: 60_000 });
  if (r.code !== 0 && !NOT_FOUND.test(`${r.stderr}${r.stdout}`) && !/not running|stopped/i.test(`${r.stderr}${r.stdout}`)) {
    throw new Error(`could not stop ${id}: ${cliMessage(r)}`);
  }
}

export const appleRuntime: ContainerRuntime = {
  name: 'apple',

  async create(spec) {
    await ensureSystem();
    await ensureImage();
    const name = containerNameFor(spec.botId);
    if (await inspect(name)) return name;
    const args = appleCreateArgs(spec, {
      name,
      image: COMPUTER_IMAGE,
      cpus: cpuArg(Number(process.env.COMPUTER_CPU_LIMIT ?? 1)),
      memory: memoryArg(memoryLimit()),
    });
    const created = await runContainer(args, { timeoutMs: 120_000 });
    if (created.code !== 0) throw new Error(`could not create ${name}: ${cliMessage(created)}`);
    await appleRuntime.start(name);
    return name;
  },

  async start(id) {
    await ensureSystem();
    const r = await runContainer(['start', id], { timeoutMs: 120_000 });
    if (r.code !== 0 && !/already running|is running/i.test(`${r.stderr}${r.stdout}`)) {
      throw new Error(`could not start ${id}: ${cliMessage(r)}`);
    }
  },

  stop,

  async remove(id) {
    const r = await runContainer(['delete', '--force', id], { timeoutMs: 60_000 });
    if (r.code !== 0 && !NOT_FOUND.test(`${r.stderr}${r.stdout}`)) throw new Error(`could not remove ${id}: ${cliMessage(r)}`);
  },

  async status(id): Promise<ContainerStatus> {
    const c = await inspect(id);
    if (!c) return { exists: false, running: false };
    return { exists: true, running: c.state === 'running', paused: false, status: c.state };
  },

  async exec(id, cmd, vars, timeoutMs, stdin): Promise<ExecResult> {
    const args = ['exec'];
    if (stdin !== undefined) args.push('--interactive');
    args.push('--workdir', '/home/bot');
    for (const [k, v] of Object.entries(vars)) args.push('--env', `${k}=${v}`);
    args.push(id, ...withTimeout(cmd, timeoutMs));
    // The guest's `timeout` ends the command; this one only guards a wedged CLI or VM.
    const r = await runContainer(args, { input: stdin, timeoutMs: timeoutMs > 0 ? timeoutMs + 15_000 : 0 });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  },

  async endpoint(id, displayIndex, kind: ScreenKind): Promise<ScreenEndpoint> {
    const c = await inspect(id);
    if (!c || c.state !== 'running') throw new ScreenUnreachableError(`the bot's VM is ${c?.state ?? 'gone'}, so its screen cannot be reached`);
    if (!c.ip) throw new ScreenUnreachableError("the bot's VM has no network address yet");
    return { host: c.ip, port: screenContainerPort(kind, displayIndex), transport: 'network' };
  },

  /** Counted at its whole limit (COMPUTER_MEMORY_RESERVATION may lower it; "0" turns the check off). */
  reservation() {
    const raw = process.env.COMPUTER_MEMORY_RESERVATION?.trim();
    if (raw === '0') return 0;
    return Math.min(raw ? memoryBytes(raw, 'COMPUTER_MEMORY_RESERVATION') : memoryLimit(), memoryLimit());
  },

  /** Most of the Mac's RAM can go to bot VMs; the rest is for macOS and Orbit itself. */
  async hostMemory() {
    return Math.floor(os.totalmem() * 0.75);
  },

  async liveBots() {
    const r = await runContainer(['list', '--format', 'json']);
    if (r.code !== 0) return [];
    return parseInspect(r.stdout)
      .filter((c) => c.state === 'running' && c.labels['orbit.managed'] === 'true' && c.labels['orbit.botId'])
      .map((c) => ({ id: c.id, botId: c.labels['orbit.botId']! }));
  },

  async problem() {
    try {
      await ensureSystem();
      return null;
    } catch (e) {
      if (e instanceof AppleRuntimeMissing) return e.message;
      return String((e as Error)?.message ?? e);
    }
  },
};


/** For the settings screen: is the CLI there, and is its service up. Starts nothing. */
export async function appleStatus(): Promise<{ installed: boolean; running: boolean }> {
  try {
    containerBinary();
  } catch {
    return { installed: false, running: false };
  }
  return { installed: true, running: await systemRunning().catch(() => false) };
}

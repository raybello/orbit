import type { ScreenEndpoint, ScreenKind } from './reach.js';

/**
 * What a bot's computer needs from whatever runs containers. Docker (the Engine API) is the default;
 * on a Mac with no Docker, Apple's `container` runs each computer as its own lightweight VM. The
 * screens, the desk and the provider's lifecycle only ever create a container, run commands in it
 * and dial two ports, so they are the same for both.
 */

export interface ContainerStatus {
  exists: boolean;
  /** True for a paused container too: its processes exist, they are only frozen. */
  running: boolean;
  paused?: boolean;
  status?: string;
}

export interface ExecResult { stdout: string; stderr: string; code: number }

export interface BotContainerSpec {
  botId: string;
  homePath: string;
  /** Display index claimed for the bot's first screen; fixes which ports the screen listens on. */
  displayIndex: number;
}

export interface ContainerRuntime {
  readonly name: 'docker' | 'apple';
  /** Create the bot's container (building or pulling the image first) and start it. Idempotent. */
  create(spec: BotContainerSpec): Promise<string>;
  start(containerId: string): Promise<void>;
  /** Stop it, keeping it. A container that is not there is already stopped. */
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  status(containerId: string): Promise<ContainerStatus>;
  /** Freeze every process (no CPU, memory kept). Absent when the runtime cannot. */
  pause?(containerId: string): Promise<void>;
  unpause?(containerId: string): Promise<void>;
  /**
   * Run a command in the container. With `timeoutMs` it runs under coreutils `timeout`, so exit
   * code 124 means it ran out. `stdin` is how a secret reaches a command without being part of it.
   */
  exec(containerId: string, cmd: string[], env: Record<string, string>, timeoutMs: number, stdin?: Buffer): Promise<ExecResult>;
  /** Where the server dials one of the screen's ports. */
  endpoint(containerId: string, displayIndex: number, kind: ScreenKind): Promise<ScreenEndpoint>;
  /** Called on every boot of an existing container, for runtime-specific reachability fixes. */
  ensureReachable?(containerId: string): Promise<void>;
  /** What one running bot is counted at when deciding whether another fits, in bytes (0 = no check). */
  reservation(): number;
  /** Memory the bots share, in bytes (0 when unknown). */
  hostMemory(): Promise<number>;
  /** Bot containers holding memory right now. */
  liveBots(): Promise<{ id: string; botId: string }[]>;
  /** A short, actionable reason this runtime is unusable, or null when it answers. */
  problem(): Promise<string | null>;
}

/** Run a command under coreutils `timeout`, so a stuck desktop tool cannot hold a request forever. */
export function withTimeout(cmd: string[], timeoutMs: number): string[] {
  return timeoutMs > 0 ? ['timeout', '-k', '5', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...cmd] : cmd;
}

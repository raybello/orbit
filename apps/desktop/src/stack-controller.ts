import type { DesktopGpuVoice } from '@orbit/contracts';
/**
 * The thing `main.ts` holds: whichever stack controller this machine ended up with.
 *
 * A discriminated union of the two concrete controllers, not one loose interface: every
 * member is always present, so `main.ts` branches on `kind` (exhaustively) and on nothing
 * else — no `?.()` for a method one variant happens to have, no `instanceof` to reach one.
 */

import type { DesktopLocalStackState, StackKind } from './shared/api';


/** What both controllers answer the same way; `kind` says which implementation it is. */
export interface StackBase {
  /** `userData/stack`: the folder holding `.env`, secrets and logs. */
  readonly stackDir: string;
  state(): DesktopLocalStackState;
  webUrl(): string;
  token(): string | null;
  start(): Promise<DesktopLocalStackState>;
  stop(): Promise<DesktopLocalStackState>;
  abort(): void;
  /**
   * Is the stack at this URL the one this controller runs? The Docker controller answers
   * asynchronously (it probes `GET /api/desktop/probe` for the image tag); the native one
   * knows from its own state and answers at once. `await` handles either, which is why the
   * return type is a union and not a promise.
   */
  matchesDesiredStack(desiredUrl?: string): boolean | Promise<boolean>;
}

/** Orbit's server in Docker Compose — the default on every platform. */
export interface DockerStack extends StackBase {
  readonly kind: 'docker';
  /**
   * The SESSION_SECRET this stack signs sessions with, for the owner-key sign-in
   * (`desktop-session.ts`). Null before the stack has generated its secrets.
   */
  sessionSecret(): string | null;
  resourceDir(): string;
  /** GPU voice (the audio.cpp sidecar): can it run here, is it on, what is it doing. */
  gpuVoiceStatus(): Promise<DesktopGpuVoice>;
  /** Install (pull + start) or remove the sidecar; the person's choice. */
  setGpuVoice(on: boolean): Promise<DesktopGpuVoice>;
}

/** The Docker-free stack: Orbit's server as supervised Node processes. */
export interface NativeStack extends StackBase {
  readonly kind: 'native';
  /** As above, once `start()` has generated `secrets.json`. */
  sessionSecret(): string | null;
  /** Kill children immediately; native stacks need this on quit. */
  dispose(): void;
}

export type StackController = DockerStack | NativeStack;

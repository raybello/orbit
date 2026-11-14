/**
 * The thing `main.ts` holds: whichever stack controller this machine ended up with.
 *
 * Both controllers satisfy this structurally, so main never branches on the class — only
 * on `kind`, for wording and for quit-time teardown.
 */

import type { DesktopLocalStackState } from './shared/api';

export type StackKind = 'docker' | 'native';

export interface StackController {
  /** Absent on `LocalStackController`, which is the default everywhere. */
  readonly kind?: StackKind;
  /** `userData/stack`: the folder holding `.env`, secrets and logs. */
  readonly stackDir: string;
  state(): DesktopLocalStackState;
  webUrl(): string;
  token(): string | null;
  /**
   * The SESSION_SECRET this stack signs sessions with, for the owner-key sign-in
   * (`desktop-session.ts`). Null before the stack has generated its secrets.
   */
  sessionSecret?(): string | null;
  /**
   * Create the stack's `.env` ahead of `start()`, so `HERMES_KEY` can be mirrored into it
   * before `compose up` reads the container's environment. Returns the file, or null.
   */
  prepareEnvFile?(): string | null;
  start(): Promise<DesktopLocalStackState>;
  stop(): Promise<DesktopLocalStackState>;
  abort(): void;
  /** Kill children immediately; native stacks need this on quit. */
  dispose?(): void;
  /**
   * Is the stack at this URL the one this controller runs? The Docker controller answers
   * asynchronously (it probes `GET /api/desktop/probe` for the image tag); the native one
   * knows from its own state.
   */
  matchesDesiredStack(desiredUrl?: string): boolean | Promise<boolean>;
}

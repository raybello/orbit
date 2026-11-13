/**
 * The one interface the rest of the server uses to reach a bot's computer. Two implementations:
 * the shared Orgo computer (computer.ts) and one Docker container per bot (docker-provider.ts).
 * Nothing above this line knows which one a bot has.
 */

/**
 * The relay's upstream: a connected, bidirectional byte stream to a VNC server. Orgo's is a
 * WebSocket (websockify); a container's x11vnc speaks raw RFB over TCP, so both are wrapped here
 * and vnc.ts only ever sees bytes.
 */
export interface VncStream {
  send(data: Buffer): void;
  close(): void;
  onData(cb: (data: Buffer) => void): void;
  /** Called once when the stream ends; `reason` is for logs. */
  onClose(cb: (reason: string) => void): void;
}

export interface ComputerRef {
  /** Internal id: the bot id for a container, the Orgo computer id for the shared computer. */
  computerId: string;
  kind: 'orgo' | 'docker';
}

export interface ScreenRef {
  screenId: string;
  /** Docker only: host port the screen's x11vnc listens on. */
  vncPort?: number;
  /** Docker only: the password the relay authenticates to VNC with. */
  viewToken?: string;
  /** Chrome DevTools port of the browser on this screen. */
  cdpPort?: number;
}

export interface BashResult { output: string; exit_code: number }

export interface ScreenShot { data: Buffer; mime: string }

export interface ComputerProvider {
  readonly kind: 'orgo' | 'docker';

  /** Provision or resume the bot's computer. Idempotent. */
  ensureComputer(botId: string): Promise<ComputerRef>;

  /** The screen id the bot already has, or null. Does not boot anything. */
  screenIdFor(botId: string): string | null;

  /** The bot's screen on that computer (created on first use). */
  screenFor(userId: string, botId: string): Promise<{ computerId: string; screenId: string }>;

  /** Make sure the screen is set up and dressed as the bot's own computer. */
  readyScreen(userId: string, botId: string, opts?: { redress?: boolean }): Promise<void>;

  /** Close what is open on the screen and bring the browser back to its home screen. Logins stay. */
  resetScreen(userId: string, botId: string): Promise<void>;

  /** Run a bash command on the bot's screen. */
  bash(botId: string, command: string, timeoutSec?: number, screenId?: string | null): Promise<BashResult>;

  /** Write a file to the bot's computer. */
  writeFile(botId: string, file: string, content: string | Buffer, mode?: string): Promise<void>;

  /** Read a file from the bot's computer, or null if it is not there. */
  readFile(botId: string, file: string): Promise<Buffer | null>;

  /** DevTools (CDP) address of the browser on this bot's screen. */
  cdpUrl(botId: string, screenId: string): Promise<string>;

  /** Open the upstream VNC connection for the relay in vnc.ts. */
  vncConnect(userId: string, botId: string, screenId: string, mode: 'watch' | 'control'): Promise<VncStream>;

  /** The VNC password the relay authenticates upstream with (never reaches the browser). */
  vncPassword(botId: string, screenId: string): Promise<string>;

  /**
   * Docker only: whether key events from a viewer must be applied through the computer's own
   * tools instead of being forwarded to the VNC server (whose synthetic keys never reach X here).
   */
  readonly translateKeys?: boolean;

  /** Apply one viewer key press on the screen. Only used when `translateKeys` is set. */
  pressKey?(botId: string, screenId: string, keysym: number, down: boolean): Promise<void>;

  /** Whether input from a browser in `mode` may reach the screen. */
  inputAllowed(botId: string, screenId: string, mode: 'watch' | 'control'): Promise<boolean>;

  /** A human takes interactive control of the screen (the bot's own input pauses). */
  takeControl(botId: string, screenId: string): Promise<void>;

  /** Hand control back to the bot. */
  giveControl(botId: string, screenId: string): Promise<void>;

  /** A PNG/JPEG of the current screen, or null when the computer is not running. */
  screenshot(botId: string, screenId: string): Promise<ScreenShot | null>;

  /** Stop the computer, keeping its home and state (Docker: checkpoint + stop the container). */
  suspend(botId: string): Promise<void>;

  /** The bot is gone: destroy its computer and, when asked, its workspace. */
  destroy(botId: string, opts?: { wipeWorkspace?: boolean }): Promise<void>;
}

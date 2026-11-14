import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { env } from './env.js';
import { tcpVncStream } from './lib/vnc-stream.js';
import { dockerBox } from './docker/docker-box.js';
import { containerStatus, createBotContainer, removeContainer, startContainer, stopContainer } from './docker/container.js';
import { ensureScreen, screenPorts, teardownScreen } from './docker/screen.js';
import { describeEndpoint, ensureBotOnNetwork, screenEndpointFor, serverPlacement } from './docker/reach.js';
import { checkpointWorkspace, ensureHomeDir, homeDirFor, restoreWorkspace, wipeWorkspace } from './docker/workspace.js';
import { claimScreen, dockerComputers, ensureComputerRow, getComputer, getScreen, saveScreen, setComputerState, setControlToken, touchScreen, deleteComputerRow, deleteScreen, type ScreenRow } from './computer-store.js';
import { dressScreen, resetScreen as resetDesk, type DeskBot } from './desk.js';
import type { BashResult, ComputerProvider, ComputerRef, ScreenShot, VncStream } from './computer-provider.js';

/**
 * One Docker container per managed bot. The container is a small Linux desktop (Xvfb + x11vnc +
 * Chrome) whose /home/bot is a host folder, so stopping it keeps everything that matters: logins,
 * files, the desk's own state.
 *
 * Screens: one per container. The display index is unique across all bots, which is what keeps each
 * bot's VNC and DevTools ports distinct on the host.
 */

const REFRESH_SCREEN_MS = 120_000;

function deskBot(botId: string): (DeskBot & { userId: string }) | null {
  const b = db.prepare('SELECT id, user_id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(botId) as any;
  return b
    ? { id: b.id, userId: b.user_id, name: b.name, label: b.label ?? '', avatarShape: b.avatar_shape, avatarColor: b.avatar_color }
    : null;
}

/** X keysym names for the characters a person types. Letters and digits are their own names. */
const ASCII_NAMES: Record<string, string> = {
  ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar', '%': 'percent',
  '&': 'ampersand', "'": 'apostrophe', '(': 'parenleft', ')': 'parenright', '*': 'asterisk', '+': 'plus',
  ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', ':': 'colon', ';': 'semicolon', '<': 'less',
  '=': 'equal', '>': 'greater', '?': 'question', '@': 'at', '[': 'bracketleft', '\\': 'backslash',
  ']': 'bracketright', '^': 'asciicircum', '_': 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar',
  '}': 'braceright', '~': 'asciitilde',
};

const KEY_NAMES: Record<number, string> = {
  0xff0d: 'Return', 0xff8d: 'KP_Enter', 0xff08: 'BackSpace', 0xff09: 'Tab', 0xff1b: 'Escape',
  0xffff: 'Delete', 0xff50: 'Home', 0xff57: 'End', 0xff55: 'Prior', 0xff56: 'Next',
  0xff51: 'Left', 0xff52: 'Up', 0xff53: 'Right', 0xff54: 'Down',
  0xffe1: 'Shift_L', 0xffe2: 'Shift_R', 0xffe3: 'Control_L', 0xffe4: 'Control_R',
  0xffe9: 'Alt_L', 0xffea: 'Alt_R', 0xffeb: 'Super_L', 0xffec: 'Super_R',
  0xffbe: 'F1', 0xffbf: 'F2', 0xffc0: 'F3', 0xffc1: 'F4', 0xffc2: 'F5', 0xffc3: 'F6',
  0xffc4: 'F7', 0xffc5: 'F8', 0xffc6: 'F9', 0xffc7: 'F10', 0xffc8: 'F11', 0xffc9: 'F12',
  0xff63: 'Insert', 0xff67: 'Menu', 0xffe5: 'Caps_Lock',
};

function keyName(keysym: number): string | null {
  const named = KEY_NAMES[keysym];
  if (named) return named;
  if (keysym >= 0x20 && keysym <= 0x7e) {
    const ch = String.fromCharCode(keysym);
    return ASCII_NAMES[ch] ?? ch;
  }
  return null;
}

export class DockerComputerProvider implements ComputerProvider {
  readonly kind = 'docker' as const;
  /** Viewer keystrokes are applied with xdotool: a VNC server's synthetic keys never reach X here. */
  readonly translateKeys = true;
  private keyBuffers = new Map<string, { parts: { kind: 'type' | 'down' | 'up'; text: string }[]; timer: ReturnType<typeof setTimeout> | null; screenId: string }>();

  /** One boot per bot at a time; concurrent callers share it. */
  private booting = new Map<string, Promise<ComputerRef>>();
  /** Dressing happens once per server run per bot until something asks for a redress. */
  private dressing = new Map<string, Promise<void>>();

  // ------------------------------------------------------------ lifecycle

  async ensureComputer(botId: string): Promise<ComputerRef> {
    const running = this.booting.get(botId);
    if (running) return running;
    const p = this.boot(botId).finally(() => this.booting.delete(botId));
    this.booting.set(botId, p);
    return p;
  }

  private async boot(botId: string): Promise<ComputerRef> {
    const homePath = homeDirFor(botId);
    const row = ensureComputerRow(botId, 'docker', homePath);
    const screen = claimScreen(botId, env.computerMaxDisplays, randomUUID);

    if (row.container_id) {
      const status = await containerStatus(row.container_id);
      if (status.exists) {
        this.assertPortsMatch(screen, row.container_id);
        if (!status.running) {
          setComputerState(botId, 'booting', { containerId: row.container_id });
          await startContainer(row.container_id);
          await this.afterStart(botId, row.container_id);
        } else if (row.state !== 'running') {
          await this.afterStart(botId, row.container_id);
        }
        await this.ensureReachable(botId, row.container_id);
        setComputerState(botId, 'running', { containerId: row.container_id, error: null, homePath });
        return { computerId: botId, kind: 'docker' };
      }
      // The container is gone (docker prune, or another machine): make a fresh one below.
      deleteScreen(botId);
      setComputerState(botId, 'stopped', { containerId: null, error: null });
    }

    await ensureHomeDir(botId);
    await restoreWorkspace(botId);
    const fresh = claimScreen(botId, env.computerMaxDisplays, randomUUID);
    setComputerState(botId, 'booting', { containerId: null, error: null, homePath });
    try {
      const containerId = await createBotContainer({ botId, homePath, displayIndex: fresh.display_index });
      await this.afterStart(botId, containerId);
      setComputerState(botId, 'running', { containerId, error: null, homePath });
      console.log(`[docker] ${botId} is running in ${containerId.slice(0, 12)} on display ${fresh.display_index}`);
      return { computerId: botId, kind: 'docker' };
    } catch (e: any) {
      const message = String(e?.message ?? e);
      setComputerState(botId, 'error', { error: message });
      throw new Error(message);
    }
  }

  /** A fresh container has no desktops: clear stale processes and set the screen up again. */
  private async afterStart(botId: string, containerId: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 300));
    await resetScreenRuntime(containerId);
    const screen = getScreen(botId);
    if (screen) saveScreen({ ...screen, ensured_at: null });
  }

  /** The published ports were fixed when the container was created; a mismatch means a new one. */
  private assertPortsMatch(screen: ScreenRow, containerId: string): void {
    const expected = screenPorts(screen.display_index);
    if (screen.vnc_port !== expected.vncPort || screen.cdp_port !== expected.cdpPort) {
      throw new Error(`container ${containerId.slice(0, 12)} was created for another display; remove it and open the bot again`);
    }
  }

  /**
   * A bot's screen is dialed over the Docker network the server shares with it (a containerized
   * server) or over published loopback ports (a server on the host). A container made before the
   * server moved into a container sits on the default bridge, which is a different bridge with no
   * route between them, so it joins the server's network here.
   */
  private async ensureReachable(botId: string, containerId: string): Promise<void> {
    const placement = await serverPlacement();
    if (!placement.inContainer || !placement.network) return;
    try {
      if (await ensureBotOnNetwork(containerId, placement.network)) {
        console.log(`[docker] ${botId} joined ${placement.network} so its screen is reachable from the server's container`);
      }
    } catch (e: any) {
      console.warn(`[docker] could not put ${botId}'s container on ${placement.network}: ${String(e?.message ?? e)}`);
    }
  }

  private containerId(botId: string): string {
    const row = getComputer(botId);
    if (!row?.container_id) throw new Error(`${botId} has no computer yet`);
    return row.container_id;
  }

  // ------------------------------------------------------------ screens

  screenIdFor(botId: string): string | null {
    return getScreen(botId)?.screen_id ?? null;
  }

  async screenFor(userId: string, botId: string): Promise<{ computerId: string; screenId: string }> {
    await this.ensureComputer(botId);
    const containerId = this.containerId(botId);
    let screen = getScreen(botId);
    if (!screen) throw new Error(`${botId} has no screen`);
    if (!screen.ensured_at || Date.now() - screen.ensured_at > REFRESH_SCREEN_MS) {
      try {
        await ensureScreen(containerId, screen.display_index, screen.view_token ?? randomUUID());
      } catch (e: any) {
        setComputerState(botId, 'error', { error: String(e?.message ?? e) });
        throw e;
      }
      touchScreen(botId, screen.screen_id, { ensuredAt: Date.now() });
      screen = getScreen(botId)!;
    }
    return { computerId: botId, screenId: screen.screen_id };
  }

  async readyScreen(userId: string, botId: string, opts: { redress?: boolean } = {}): Promise<void> {
    const { screenId } = await this.screenFor(userId, botId);
    if (opts.redress) this.dressing.delete(botId);
    let d = this.dressing.get(botId);
    if (!d) {
      const bot = deskBot(botId);
      d = bot
        ? dressScreen(bot, screenId, dockerBox(this.containerId(botId))).catch((e) => {
            console.warn(`[docker] could not dress ${screenId} for ${botId}: ${e?.message ?? e}`);
            this.dressing.delete(botId);
          })
        : Promise.resolve();
      this.dressing.set(botId, d);
    }
    await d;
  }

  async resetScreen(userId: string, botId: string): Promise<void> {
    const { screenId } = await this.screenFor(userId, botId);
    const bot = deskBot(botId);
    if (bot) await resetDesk(bot, screenId, dockerBox(this.containerId(botId)));
  }

  // ------------------------------------------------------------ commands and files

  async bash(botId: string, command: string, timeoutSec = 60, screenId?: string | null): Promise<BashResult> {
    await this.ensureComputer(botId);
    return dockerBox(this.containerId(botId)).bash(command, timeoutSec, screenId);
  }

  async writeFile(botId: string, file: string, content: string | Buffer, mode = '0644'): Promise<void> {
    await this.ensureComputer(botId);
    await dockerBox(this.containerId(botId)).writeFile(file, content, mode);
  }

  async readFile(botId: string, file: string): Promise<Buffer | null> {
    await this.ensureComputer(botId);
    return dockerBox(this.containerId(botId)).readFile(file);
  }

  async cdpUrl(botId: string, screenId: string): Promise<string> {
    const screen = getScreen(botId, screenId) ?? getScreen(botId);
    if (!screen) throw new Error(`${botId} has no screen`);
    const endpoint = await screenEndpointFor(this.containerId(botId), screen.display_index, 'cdp');
    return `http://${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`;
  }

  // ------------------------------------------------------------ viewing and control

  async vncConnect(_userId: string, botId: string, screenId: string): Promise<VncStream> {
    const screen = getScreen(botId, screenId);
    if (!screen?.vnc_port) throw new Error(`${botId} has no VNC port yet`);
    const containerId = this.containerId(botId);
    // Docker's port forward (and, on Docker Desktop/colima, the host's own forward) can trail the
    // container's start by a moment; a viewer opening the bot right after it wakes may beat it.
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        // Re-resolved every attempt: the first attempt is also what attaches a container made
        // before the server ran inside Docker to the server's network.
        const endpoint = await screenEndpointFor(containerId, screen.display_index, 'vnc');
        if (attempt === 0) console.log(`[vnc] ${botId} display ${screen.display_index} upstream ${describeEndpoint(endpoint)}`);
        return await tcpVncStream(endpoint.port, endpoint.host);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw lastError;
  }

  async vncPassword(botId: string, screenId: string): Promise<string> {
    const screen = getScreen(botId, screenId);
    if (!screen?.view_token) throw new Error(`${botId} has no VNC password yet`);
    return screen.view_token.slice(0, 8);
  }

  /** A control viewer is the lease: only a browser that asked for control may type. */
  async inputAllowed(_botId: string, _screenId: string, mode: 'watch' | 'control'): Promise<boolean> {
    return mode === 'control';
  }

  async takeControl(botId: string, screenId: string): Promise<void> {
    setControlToken(botId, screenId, null);
  }

  async giveControl(botId: string, screenId: string): Promise<void> {
    setControlToken(botId, screenId, randomUUID());
  }

  // ------------------------------------------------------------ pictures, sleep, teardown

  async screenshot(botId: string, screenId: string): Promise<ScreenShot | null> {
    const row = getComputer(botId);
    if (!row?.container_id || row.state !== 'running') return null;
    const screen = getScreen(botId, screenId) ?? getScreen(botId);
    if (!screen) return null;
    try {
      const r = await dockerBox(row.container_id).bash(
        'import -display "$DISPLAY" -window root png:- 2>/dev/null | base64 -w0',
        20,
        screen.screen_id,
      );
      if (r.exit_code !== 0) return null;
      const b64 = r.output.trim();
      if (!b64) return null;
      return { data: Buffer.from(b64, 'base64'), mime: 'image/png' };
    } catch {
      return null;
    }
  }

  /**
   * Viewer key presses, applied with xdotool inside the container.
   *
   * The presses of one burst are collected for a few milliseconds and run as a single shell script:
   * a docker exec per keystroke is far too slow to type at a human's pace, and it reorders under
   * load. Printable characters go through `xdotool type`; named keys (Return, modifiers, arrows)
   * keep down/up so holding them works.
   */
  async pressKey(botId: string, screenId: string, keysym: number, down: boolean): Promise<void> {
    const name = keyName(keysym);
    if (!name) return;
    const printable = keysym >= 0x20 && keysym <= 0x7e;
    if (printable && !down) return;
    let buf = this.keyBuffers.get(botId);
    if (!buf) {
      buf = { parts: [], timer: null, screenId };
      this.keyBuffers.set(botId, buf);
    }
    buf.screenId = screenId;
    buf.parts.push(printable ? { kind: 'type', text: String.fromCharCode(keysym) } : { kind: down ? 'down' : 'up', text: name });
    if (!buf.timer) {
      buf.timer = setTimeout(() => void this.flushKeys(botId), 40);
      buf.timer.unref?.();
    }
  }

  private async flushKeys(botId: string): Promise<void> {
    const buf = this.keyBuffers.get(botId);
    if (!buf) return;
    this.keyBuffers.delete(botId);
    if (buf.timer) clearTimeout(buf.timer);
    const row = getComputer(botId);
    if (!row?.container_id || !buf.parts.length) return;
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    const lines: string[] = [];
    let pending = '';
    for (const part of buf.parts) {
      if (part.kind === 'type') {
        pending += part.text;
        continue;
      }
      if (pending) {
        lines.push(`xdotool type --clearmodifiers --delay 0 -- ${q(pending)}`);
        pending = '';
      }
      lines.push(`xdotool ${part.kind === 'down' ? 'keydown' : 'keyup'} -- ${q(part.text)}`);
    }
    if (pending) lines.push(`xdotool type --clearmodifiers --delay 0 -- ${q(pending)}`);
    const r = await dockerBox(row.container_id)
      .bash(`set -e; ${lines.join('; ')}`, 20, buf.screenId)
      .catch((e) => ({ exit_code: -1, output: String((e as any)?.message ?? e) }));
    if (r.exit_code !== 0) console.warn(`[vnc] keys failed: ${String(r.output).slice(0, 200)}`);
  }

  async suspend(botId: string): Promise<void> {
    const row = getComputer(botId);
    if (!row?.container_id) return;
    setComputerState(botId, 'suspending', { containerId: row.container_id });
    try {
      await checkpointWorkspace(botId).catch((e) => console.warn(`[docker] checkpoint failed for ${botId}: ${e?.message ?? e}`));
      await stopContainer(row.container_id);
      const screen = getScreen(botId);
      if (screen) saveScreen({ ...screen, ensured_at: null });
      setComputerState(botId, 'suspended', { containerId: row.container_id, error: null });
      this.dressing.delete(botId);
    } catch (e: any) {
      setComputerState(botId, 'error', { error: String(e?.message ?? e) });
      throw e;
    }
  }

  async destroy(botId: string, opts: { wipeWorkspace?: boolean } = {}): Promise<void> {
    const row = getComputer(botId);
    const screen = getScreen(botId);
    if (row?.container_id && screen) {
      await teardownScreen(row.container_id, screen.display_index, screen.screen_id).catch(() => undefined);
    }
    if (row?.container_id) await removeContainer(row.container_id).catch((e) => console.warn(`[docker] could not remove ${botId}'s container: ${e?.message ?? e}`));
    deleteComputerRow(botId);
    this.dressing.delete(botId);
    if (opts.wipeWorkspace) await wipeWorkspace(botId);
    else await checkpointWorkspace(botId).catch(() => undefined);
  }
}

/** Imported lazily to keep the module graph of screens.ts small in tests. */
async function resetScreenRuntime(containerId: string): Promise<void> {
  const { resetScreens } = await import('./docker/screen.js');
  await resetScreens(containerId);
}

function userIdFor(botId: string): string {
  return (db.prepare('SELECT user_id FROM bots WHERE id=?').get(botId) as any)?.user_id ?? '';
}

/**
 * Suspend containers nobody is looking at or working in. The shared computer is never paused, but a
 * bot's own container costs memory for as long as it runs, so it goes to sleep after
 * COMPUTER_IDLE_TIMEOUT_MIN minutes and comes back by itself on the next screen or task.
 */
export function startDockerIdleSuspender(): () => void {
  if (!(env.computerIdleTimeoutMin > 0)) return () => {};
  const idleMs = env.computerIdleTimeoutMin * 60_000;
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const { botViewerCount, botLastSeen } = await import('./idle.js');
      const { isBotBusy } = await import('./agent/loop.js');
      for (const row of dockerComputers()) {
        if (row.state !== 'running') continue;
        if (botViewerCount(row.bot_id) > 0 || isBotBusy(row.bot_id)) continue;
        const last = Math.max(botLastSeen(row.bot_id), getScreen(row.bot_id)?.idle_at ?? 0, row.updated_at);
        if (Date.now() - last < idleMs) continue;
        console.log(`[docker] suspending ${row.bot_id}: idle for ${Math.round((Date.now() - last) / 60_000)} min`);
        await dockerProvider.suspend(row.bot_id).catch((e) => console.warn(`[docker] idle suspend failed for ${row.bot_id}: ${e?.message ?? e}`));
      }
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), Math.min(60_000, idleMs));
  timer.unref?.();
  return () => clearInterval(timer);
}

export const dockerProvider = new DockerComputerProvider();

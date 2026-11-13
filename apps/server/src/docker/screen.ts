import { execInContainer, runScript } from './exec.js';

/**
 * A bot's screen inside its container: an Xvfb display, a window manager, and x11vnc on a host
 * port. `desk.ts` then dresses that display (wallpaper, dock, the bot's Chrome), exactly as it does
 * on the shared Orgo computer.
 *
 * One screen per container is what the provider creates: each bot has its own container, and the
 * display index (unique across all bots) fixes the VNC and DevTools ports.
 */

export interface ScreenLayout { display: string; displayNumber: number; vncPort: number; cdpPort: number }

export function screenPorts(index: number): ScreenLayout {
  if (!Number.isInteger(index) || index < 1) throw new Error(`invalid display index ${index}`);
  return { display: `:${index}`, displayNumber: index, vncPort: 5900 + index, cdpPort: 9200 + index };
}

/**
 * Chrome binds DevTools to the container's loopback whatever address it is given, so a published
 * port cannot reach it directly. socat listens on the container's own interface and passes the
 * connection on; the host publishes that port as the screen's CDP port.
 */
export function cdpBridgePort(index: number): number {
  return 9300 + index;
}

/** VNC's password is at most 8 bytes; the relay authenticates with the same 8 characters. */
export function vncPassword(viewToken: string): string {
  return viewToken.slice(0, 8);
}

const LOGS = '/home/bot/.local/share/hq/logs';

/** Start (or confirm) the display, window manager and VNC server for one screen. */
export async function ensureScreen(containerId: string, index: number, viewToken: string): Promise<void> {
  const s = screenPorts(index);
  const pass = vncPassword(viewToken);
  if (!/^[\x20-\x7e]{8}$/.test(pass)) throw new Error('VNC password must be 8 printable characters');
  const script = `
set -eu
export HOME=/home/bot
export DISPLAY=${s.display}
mkdir -p ${LOGS} /tmp/.X11-unix /home/bot/.fluxbox /home/bot/.local/share/hq
log=${LOGS}/screen-${s.displayNumber}
if ! xdpyinfo -display ${s.display} >/dev/null 2>&1; then
  rm -f /tmp/.X${s.displayNumber}-lock /tmp/.X11-unix/X${s.displayNumber}
  nohup Xvfb ${s.display} -screen 0 1440x900x24 -ac +extension RANDR +render -noreset -nolisten tcp </dev/null >"$log-xvfb.log" 2>&1 &
  for i in $(seq 1 100); do xdpyinfo -display ${s.display} >/dev/null 2>&1 && break; sleep 0.1; done
fi
xdpyinfo -display ${s.display} >/dev/null 2>&1 || { echo 'the display did not start' >&2; tail -c 2000 "$log-xvfb.log" >&2 || true; exit 1; }
if ! wmctrl -m >/dev/null 2>&1; then
  printf 'session.screen0.toolbar.visible: false\\nsession.screen0.toolbar.autoHide: true\\nsession.screen0.fullMaximization: true\\nsession.screen0.maxIgnoreIncrement: true\\n' >/home/bot/.fluxbox/init
  nohup fluxbox -rc /home/bot/.fluxbox/init </dev/null >"$log-fluxbox.log" 2>&1 &
  sleep 0.5
fi
if ! pgrep -f '[s]ocat TCP-LISTEN:${cdpBridgePort(index)}' >/dev/null 2>&1; then
  nohup socat TCP-LISTEN:${cdpBridgePort(index)},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:${s.cdpPort} </dev/null >"$log-cdp.log" 2>&1 &
fi
if ! pgrep -f '[x]0vncserver -display ${s.display} ' >/dev/null 2>&1; then
  # TigerVNC's scraping server mirrors this display and injects input through XTEST; x11vnc reads
  # the screen but its synthetic input never reaches the X server here. The password file is the
  # standard VNC one, so the relay's DES handshake is unchanged.
  x11vnc -storepasswd ${JSON.stringify(pass)} /home/bot/.local/share/hq/vnc-${s.displayNumber}.pass >/dev/null 2>&1
  nohup x0vncserver -display ${s.display} -rfbport ${s.vncPort} -PasswordFile /home/bot/.local/share/hq/vnc-${s.displayNumber}.pass -AlwaysShared -SecurityTypes VncAuth -localhost=no </dev/null >"$log-vnc.log" 2>&1 &
  # TigerVNC starts through a perl wrapper and takes a few seconds to bind.
  for i in $(seq 1 100); do (echo >/dev/tcp/127.0.0.1/${s.vncPort}) >/dev/null 2>&1 && break; sleep 0.2; done
  (echo >/dev/tcp/127.0.0.1/${s.vncPort}) >/dev/null 2>&1 || { echo 'the viewer did not start' >&2; tail -c 2000 "$log-vnc.log" >&2 || true; exit 1; }
fi
echo SCREEN_OK
`;
  const r = await runScript(containerId, `ensure-screen-${index}`, script, 90_000);
  if (r.code !== 0 || !r.stdout.includes('SCREEN_OK')) {
    throw new Error(`screen ${s.display} did not come up: ${(r.stderr || r.stdout).trim().slice(-400)}`);
  }
}

/** Kill stale desktop processes after a container start; the screens are set up again on demand. */
export async function resetScreens(containerId: string): Promise<void> {
  const script = `
set -eu
pkill -x x11vnc 2>/dev/null || true
pkill -x x0vncserver 2>/dev/null || true
pkill -x socat 2>/dev/null || true
pkill -f '[f]luxbox' 2>/dev/null || true
pkill -f '[X]vfb :' 2>/dev/null || true
pkill -f '[c]hromium' 2>/dev/null || true
pkill -f '[c]hrome' 2>/dev/null || true
sleep 0.3
rm -f /tmp/.X*-lock /tmp/.X11-unix/X*
rm -rf /home/bot/.fluxbox
echo RESET_OK
`;
  const r = await runScript(containerId, 'reset-screens', script, 30_000);
  if (r.code !== 0) throw new Error(`could not reset the screens: ${(r.stderr || r.stdout).trim().slice(-300)}`);
}

/** Stop the VNC server and display for one screen. */
export async function teardownScreen(containerId: string, index: number, screenKey?: string): Promise<void> {
  const s = screenPorts(index);
  const script = `
set -eu
pkill -f "[x]0vncserver -display ${s.display} " 2>/dev/null || true
pkill -f "[x]11vnc -display ${s.display} " 2>/dev/null || true
pkill -f "[s]ocat TCP-LISTEN:${cdpBridgePort(index)}," 2>/dev/null || true
${screenKey ? `pkill -f "[c]hromium.*--hq-screen=${s.displayNumber}" 2>/dev/null || true` : ''}
pkill -f "[X]vfb ${s.display} -screen" 2>/dev/null || true
rm -f /tmp/.X${s.displayNumber}-lock /tmp/.X11-unix/X${s.displayNumber}
echo TEARDOWN_OK
`;
  const r = await runScript(containerId, `teardown-screen-${index}`, script, 30_000);
  if (r.code !== 0) throw new Error(`could not stop screen ${s.display}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
}

/** Whether the screen's VNC port answers inside the container. */
export async function screenAlive(containerId: string, index: number): Promise<boolean> {
  const s = screenPorts(index);
  const r = await execInContainer(containerId, ['bash', '-c', `(echo >/dev/tcp/127.0.0.1/${s.vncPort}) >/dev/null 2>&1 && echo YES || echo NO`], {}, 10_000);
  return r.stdout.includes('YES');
}

import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { db } from './db.js';
import { userFromCookieHeader, userFromToken } from './lib/auth.js';
import { vncAuthResponse } from './lib/des.js';
import { providerFor } from './computer-provider-registry.js';
import { viewerClosed, viewerOpened, botViewerClosed, botViewerOpened } from './idle.js';
import type { VncStream } from './computer-provider.js';

/**
 * VNC relay: browser <-> our server <-> the bot's computer.
 * The upstream is a WebSocket to Orgo's websockify for the shared computer, or a plain TCP socket
 * to a container's x11vnc for a managed bot; both arrive here as VncStreams. The server performs
 * the RFB handshake upstream with the computer's VNC password (which is root-equivalent and never
 * reaches the browser), then offers the browser an unauthenticated RFB session. In "watch" mode,
 * client input messages (KeyEvent, PointerEvent, ClientCutText) are dropped server-side; a control
 * viewer may type.
 */

class ByteQueue {
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closed: Error | null = null;
  push(b: Buffer) { this.buf = Buffer.concat([this.buf, b]); this.drain(); }
  close(e: Error) { this.closed = e; for (const w of this.waiters) w.reject(e); this.waiters = []; }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(this.closed);
      this.waiters.push({ n, resolve, reject });
      this.drain();
    });
  }
  takeAll(): Buffer { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
  private drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

async function upstreamHandshake(q: ByteQueue, send: (b: Buffer) => void, password: string): Promise<Buffer> {
  await q.read(12); // server ProtocolVersion
  send(Buffer.from('RFB 003.008\n'));
  const n = (await q.read(1))[0];
  if (n === 0) {
    const len = (await q.read(4)).readUInt32BE();
    throw new Error(`VNC refused: ${(await q.read(len)).toString()}`);
  }
  const types = [...(await q.read(n))];
  const choice = types.includes(2) ? 2 : types.includes(1) ? 1 : -1;
  if (choice < 0) throw new Error(`Unsupported VNC security types: ${types.join(',')}`);
  send(Buffer.from([choice]));
  if (choice === 2) {
    const challenge = await q.read(16);
    send(vncAuthResponse(password, challenge));
  }
  const result = (await q.read(4)).readUInt32BE();
  if (result !== 0) {
    let reason = '';
    try { const len = (await q.read(4)).readUInt32BE(); reason = (await q.read(len)).toString(); } catch { /* none */ }
    throw new Error(`VNC auth failed ${reason}`);
  }
  send(Buffer.from([1])); // ClientInit: shared
  const head = await q.read(24); // w,h,pixfmt(16),nameLen
  const nameLen = head.readUInt32BE(20);
  const name = await q.read(nameLen);
  return Buffer.concat([head, name]);
}

async function browserHandshake(q: ByteQueue, send: (b: Buffer) => void, serverInit: Buffer) {
  send(Buffer.from('RFB 003.008\n'));
  await q.read(12);
  send(Buffer.from([1, 1])); // one security type: None
  await q.read(1);
  send(u32(0)); // SecurityResult OK
  await q.read(1); // ClientInit
  send(serverInit);
}

/** Filters a client->server RFB stream, dropping input events. Returns bytes to forward. */
class WatchFilter {
  private pending = Buffer.alloc(0);
  feed(chunk: Buffer): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const b = this.pending;
      if (!b.length) break;
      const len = msgLength(b);
      if (len === -1) { this.pending = Buffer.alloc(0); break; } // unknown: fail closed
      if (len === 0 || b.length < len) break; // need more bytes
      const msg = b.subarray(0, len);
      const t = b[0];
      if (t !== 4 && t !== 5 && t !== 6) out.push(Buffer.from(msg));
      this.pending = b.subarray(len);
    }
    return Buffer.concat(out);
  }
}

/** Length of the client message at the head of `b`, 0 if more bytes are needed to know, -1 if unknown. */
function msgLength(b: Buffer): number {
  const t = b[0];
  switch (t) {
    case 0: return 20; // SetPixelFormat
    case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2); // SetEncodings
    case 3: return 10; // FramebufferUpdateRequest
    case 4: return 8; // KeyEvent
    case 5: return 6; // PointerEvent
    case 6: return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4)); // ClientCutText (+extended)
    case 150: return 10; // EnableContinuousUpdates
    case 248: return b.length < 9 ? 0 : 9 + b[8]; // ClientFence
    case 251: return b.length < 8 ? 0 : 8 + 16 * b[6]; // SetDesktopSize
    default: return -1;
  }
}

export function attachVncRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    const user = userFromCookieHeader(req.headers.cookie)
      // A React Native WebView cannot send cookies, so native clients pass the session token in the
      // query string instead: /api/bots/:id/screen?token=<session token>.
      ?? userFromToken(url.searchParams.get('token') ?? undefined);
    const bot = user ? (db.prepare('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) as any) : null;
    if (!user || !bot) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    wss.handleUpgrade(req, socket, head, (client) => relay(client, user.id, bot.id, mode));
  });
}

/**
 * Splits a client->server RFB stream into key events (to be applied on the computer itself) and the
 * rest (which still goes to the VNC server). Needed because a VNC server's synthetic keystrokes do
 * not reach X inside a bot's container; xdotool does.
 */
class KeySplitter {
  private pending = Buffer.alloc(0);
  feed(chunk: Buffer): { forward: Buffer; keys: { keysym: number; down: boolean }[] } {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    const keys: { keysym: number; down: boolean }[] = [];
    for (;;) {
      const b = this.pending;
      if (!b.length) break;
      const len = msgLength(b);
      if (len === -1) {
        out.push(b);
        this.pending = Buffer.alloc(0);
        break;
      }
      if (len === 0 || b.length < len) break;
      if (b[0] === 4) keys.push({ down: b[1] === 1, keysym: b.readUInt32BE(4) });
      else out.push(Buffer.from(b.subarray(0, len)));
      this.pending = b.subarray(len);
    }
    return { forward: Buffer.concat(out), keys };
  }
}

/** How many control viewers each bot has; the last one out hands control back. */
const controllers = new Map<string, number>();

async function relay(client: WebSocket, userId: string, botId: string, mode: 'watch' | 'control') {
  const fromClient = new ByteQueue();
  const fromUp = new ByteQueue();
  let upstream: VncStream | null = null;
  let piping = false;
  let inputAllowed = mode === 'control';
  let holdsControl = false;
  let currentScreenId = '';
  const filter = new WatchFilter();
  const splitter = new KeySplitter();
  const provider = providerFor(botId);
  const translateKeys = Boolean(provider.translateKeys && provider.pressKey);
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    try { upstream?.close(); } catch { /* */ }
  };
  const forward = (data: Buffer) => {
    if (process.env.VNC_DEBUG === '1') console.log(`[vnc] in type=${data[0]} len=${data.length} allowed=${inputAllowed} keys=${translateKeys}`);
    if (!inputAllowed) {
      const fwd = filter.feed(data);
      if (fwd.length) upstream?.send(fwd);
      return;
    }
    if (!translateKeys) {
      upstream?.send(data);
      return;
    }
    // Keys are applied on the computer itself; everything else still goes to the VNC server.
    const { forward: rest, keys } = splitter.feed(data);
    if (rest.length) upstream?.send(rest);
    for (const k of keys) void provider.pressKey?.(botId, currentScreenId, k.keysym, k.down);
  };

  client.on('message', (data: Buffer) => {
    if (!piping) return fromClient.push(Buffer.from(data));
    forward(Buffer.from(data));
  });
  client.on('close', () => {
    viewerClosed(userId);
    botViewerClosed(botId);
    fromClient.close(new Error('client closed'));
    try { upstream?.close(); } catch { /* */ }
    if (holdsControl) {
      const left = Math.max(0, (controllers.get(botId) ?? 1) - 1);
      if (left === 0) {
        controllers.delete(botId);
        void provider.giveControl(botId, getScreenId(botId)).catch(() => undefined);
      } else controllers.set(botId, left);
    }
  });
  viewerOpened(userId); // keeps the computer awake while someone is watching (see idle.ts)
  botViewerOpened(botId);

  try {
    const { screenId } = await provider.screenFor(userId, botId);
    currentScreenId = screenId;
    // A screen nobody has used yet is bare; set it up while the person is already watching.
    provider.readyScreen(userId, botId).catch(() => {});
    const password = await provider.vncPassword(botId, screenId);
    upstream = await provider.vncConnect(userId, botId, screenId, mode);
    inputAllowed = await provider.inputAllowed(botId, screenId, mode);
    if (process.env.VNC_DEBUG === '1') console.log(`[vnc] mode=${mode} allowed=${inputAllowed} provider=${provider.kind}`);
    if (mode === 'control') {
      holdsControl = true;
      controllers.set(botId, (controllers.get(botId) ?? 0) + 1);
      await provider.takeControl(botId, screenId).catch(() => undefined);
    }
    upstream.onData((data) => {
      if (!piping) return fromUp.push(data);
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
    upstream.onClose((reason) => {
      fromUp.close(new Error(reason));
      closeAll(1000, reason);
    });

    const serverInit = await upstreamHandshake(fromUp, (b) => upstream!.send(b), password);
    await browserHandshake(fromClient, (b) => client.send(b), serverInit);
    // Flush anything that arrived during the handshake, then switch to piping.
    piping = true;
    const leftoverUp = fromUp.takeAll();
    if (leftoverUp.length) client.send(leftoverUp);
    const leftoverClient = fromClient.takeAll();
    if (leftoverClient.length) forward(leftoverClient);
  } catch (e: any) {
    const message = String(e?.message ?? e);
    // A person closing the tab mid-handshake is not a failure worth a warning.
    if (!/client closed/i.test(message)) console.warn('[vnc] relay failed', message);
    closeAll(1011, message);
  }
}

/** The bot's screen id, for the control handback when the relay itself does not hold one. */
function getScreenId(botId: string): string {
  const row = db.prepare('SELECT screen_id FROM computer_screens WHERE bot_id=? ORDER BY display_index LIMIT 1').get(botId) as any;
  return (row?.screen_id as string) ?? 'default';
}

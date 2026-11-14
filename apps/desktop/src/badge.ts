/**
 * Unread count on the dock (macOS), the taskbar (Windows) or the Unity launcher (Linux).
 *
 * The number comes from the server's own state: `GET /api/bots` returns each bot's
 * `unread`, and `GET /api/events` (SSE) tells us when anything changed. We re-read
 * `/api/bots` on change rather than trying to apply events incrementally, because the
 * server owns the count and a stale badge is worse than a slightly late one.
 *
 * Everything here is defensive by design: a badge is decoration, and must never be able
 * to take down the app or spam the network.
 */

import zlib from 'node:zlib';
import { app, nativeImage, type BrowserWindow, type Session } from 'electron';
import { ORBIT_HEADERS, type BotsResponse } from '@orbit/contracts';
import { createLogger } from '@orbit/logger';
import { normalizeServerUrl } from './setup-config';

const log = createLogger({ scope: 'badge' });

export interface BadgeController {
  /** Recompute now (used after the window finishes loading). */
  refresh(): Promise<void>;
  stop(): void;
  /** The last number applied, for tests and logs. */
  count(): number;
}

export interface StartBadgeOptions {
  serverUrl: string;
  session: Session;
  window?: BrowserWindow;
  /** Test seam: replaces the global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam: how the count is applied. */
  apply?: (count: number) => void;
}

/** Sum `unread` across bots, tolerating a body that does not match the contract. */
export function unreadFromBots(body: unknown): number {
  const bots = (body as BotsResponse | undefined)?.bots;
  if (!Array.isArray(bots)) return 0;
  return bots.reduce((total, bot) => {
    const value = Number((bot as { unread?: unknown })?.unread ?? 0);
    return total + (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  }, 0);
}

/**
 * Parse the `data:` lines out of a chunk of SSE text.
 *
 * Returns the leftover partial line so the caller can prepend it to the next chunk; an
 * event boundary without the blank line at the end means "not yet".
 */
export function parseSseChunk(buffer: string, carry = ''): { events: unknown[]; rest: string } {
  const text = carry + buffer;
  const blocks = text.split(/\n\n/);
  const rest = blocks.pop() ?? '';
  const events: unknown[] = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // A frame we cannot parse is skipped: the next /api/bots poll corrects the badge.
    }
  }
  return { events, rest };
}

/** Build the cookie header for SSE, which cannot use session.fetch's header hooks. */
async function cookieHeader(ses: Session, url: string): Promise<string> {
  try {
    const cookies = await ses.cookies.get({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

/**
 * A 16×16 rounded red dot, encoded by hand.
 *
 * A PNG file in `assets/` would need to be copied into `dist` and re-located at runtime;
 * forty lines of zlib is cheaper and works in a packaged asar.
 */
export function badgeDotPng(size = 16): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      // 1px feather so the dot does not look jagged at 100% scaling.
      const alpha = dist <= radius ? 255 : dist <= radius + 1 ? Math.round(255 * (radius + 1 - dist)) : 0;
      rgba[i] = 0xfb;
      rgba[i + 1] = 0x2b;
      rgba[i + 2] = 0x3e;
      rgba[i + 3] = alpha;
    }
  }

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return crc ^ 0xffffffff;
}

/** The default platform behaviour. */
export function applyBadge(count: number, window?: BrowserWindow): void {
  const n = count > 0 ? count : 0;
  try {
    if (process.platform === 'darwin') {
      app.dock?.setBadge(n > 0 ? String(n) : '');
      return;
    }
    if (process.platform === 'win32') {
      if (!window || window.isDestroyed() || typeof window.setOverlayIcon !== 'function') return;
      if (n === 0) {
        window.setOverlayIcon(null, '');
        return;
      }
      const image = nativeImage.createFromBuffer(badgeDotPng(16));
      window.setOverlayIcon(image, `${n} unread`);
      return;
    }
    // Linux: Unity/Dock badge where the desktop supports it.
    if (typeof app.setBadgeCount === 'function') {
      const ok = app.setBadgeCount(n);
      if (!ok) log.debug('desktop does not support badge counts');
    }
  } catch (err) {
    log.debug('badge unavailable', (err as Error).message);
  }
}

export function startBadge(options: StartBadgeOptions): BadgeController {
  const origin = normalizeServerUrl(options.serverUrl);
  if (!origin) {
    return { refresh: async () => {}, stop: () => {}, count: () => 0 };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const apply = options.apply ?? ((n: number) => applyBadge(n, options.window));
  let stopped = false;
  let current = 0;
  let abort: AbortController | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let reconnectDelay = 2_000;

  const setCount = (next: number) => {
    if (next === current) return;
    current = next;
    try {
      apply(next);
    } catch (err) {
      log.debug('badge apply failed', err);
    }
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    try {
      const res = await fetchImpl(`${origin}/api/bots`, {
        headers: { [ORBIT_HEADERS.desktop]: '1', cookie: await cookieHeader(options.session, origin) },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return;
      setCount(unreadFromBots(await res.json()));
    } catch {
      // Offline or signed out: keep the last count rather than flashing zero.
    }
  };

  /** Changes arrive in bursts (a reply, then rows, then read state); coalesce them. */
  const scheduleRefresh = () => {
    if (refreshTimer || stopped) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 750);
  };

  const stream = async (): Promise<void> => {
    while (!stopped) {
      abort = new AbortController();
      try {
        const cookie = await cookieHeader(options.session, origin);
        const res = await fetchImpl(`${origin}/api/events`, {
          headers: { accept: 'text/event-stream', [ORBIT_HEADERS.desktop]: '1', ...(cookie ? { cookie } : {}) },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events stream: HTTP ${res.status}`);

        reconnectDelay = 2_000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let carry = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          const { events, rest } = parseSseChunk(decoder.decode(value, { stream: true }), carry);
          carry = rest;
          for (const event of events) {
            const type = (event as { type?: string })?.type;
            if (!type || type === 'ping' || type === 'hello') continue;
            // Any real event can change unread; let /api/bots be the source of truth.
            scheduleRefresh();
            break;
          }
        }
      } catch (err) {
        if (stopped) return;
        log.debug('events stream dropped', (err as Error).message);
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    }
  };

  void refresh();
  void stream();

  return {
    refresh,
    count: () => current,
    stop: () => {
      stopped = true;
      abort?.abort();
      abort = null;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      setCount(0);
    },
  };
}

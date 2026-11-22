/**
 * "Allow my phone to connect": the one way the local stack is reachable from another device.
 *
 * Both stacks listen on loopback only (Docker publishes 127.0.0.1, the native server sets
 * LISTEN_HOST). While the person has this switched on, the app listens on every IPv4 interface
 * and pipes each connection to the stack's loopback port, so the phone talks to the same server
 * the app window does. Off, or the app quit, and nothing listens beyond loopback.
 *
 * `userData/phone-access.json` keeps the choice and the port, so a phone that paired once keeps
 * working across launches as long as the computer keeps its network address.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DesktopPhoneAccess } from '@orbit/contracts';

const FILE = 'phone-access.json';

interface Saved {
  enabled: boolean;
  port: number | null;
}

type Interfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * The address a phone on the same network dials: a private IPv4 on a physical interface (en0 is
 * Wi-Fi or Ethernet on a Mac), ahead of any private address on a VM bridge or VPN tunnel.
 */
export function lanAddress(interfaces: Interfaces): string | null {
  const candidates: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal && PRIVATE_V4.some((re) => re.test(info.address))) candidates.push({ name, address: info.address });
    }
  }
  const physical = candidates.find((c) => /^(en|eth|wlan|wl)/.test(c.name));
  return (physical ?? candidates[0])?.address ?? null;
}

export interface PhoneAccessOptions {
  userDataDir: string;
  /** The stack's loopback port, or null when no local stack is running. */
  targetPort: () => number | null;
  /** The computer's local-network address right now (default: lanAddress of the live interfaces). */
  lanHost?: () => string | null;
}

export class PhoneAccess {
  private readonly file: string;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private error: string | null = null;

  constructor(private readonly opts: PhoneAccessOptions) {
    this.file = path.join(opts.userDataDir, FILE);
  }

  status(): DesktopPhoneAccess {
    if (this.opts.targetPort() === null) return { phase: 'unavailable' };
    if (this.error) return { phase: 'error', error: this.error };
    const saved = this.read();
    if (!saved.enabled || !this.server) return { phase: 'off' };
    const host = (this.opts.lanHost ?? (() => lanAddress(os.networkInterfaces())))();
    return host && saved.port ? { phase: 'on', url: `http://${host}:${saved.port}` } : { phase: 'no-network' };
  }

  async set(on: boolean): Promise<DesktopPhoneAccess> {
    this.error = null;
    this.write({ ...this.read(), enabled: on });
    if (on) await this.listen();
    else await this.close();
    return this.status();
  }

  /** At launch, once the stack answers: listen again if the person left it on. */
  async resume(): Promise<void> {
    if (this.read().enabled && this.opts.targetPort() !== null) await this.listen();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async listen(): Promise<void> {
    if (this.server) return;
    const saved = this.read();
    const server = net.createServer((socket) => this.forward(socket));
    try {
      const port = await bind(server, saved.port ?? 0).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE' || saved.port === null) throw err;
        return bind(server, 0);
      });
      this.server = server;
      this.write({ enabled: true, port });
    } catch (err) {
      this.error = `Could not listen for your phone: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private forward(socket: net.Socket): void {
    const port = this.opts.targetPort();
    if (port === null) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(port, '127.0.0.1');
    this.sockets.add(socket);
    const end = () => {
      socket.destroy();
      upstream.destroy();
      this.sockets.delete(socket);
    };
    socket.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
    socket.pipe(upstream).pipe(socket);
  }

  private read(): Saved {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Saved>;
      const port = Number.isInteger(parsed.port) && parsed.port! > 0 && parsed.port! < 65_536 ? parsed.port! : null;
      return { enabled: parsed.enabled === true, port };
    } catch {
      return { enabled: false, port: null };
    }
  }

  private write(saved: Saved): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(saved)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function bind(server: net.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen({ port, host: '0.0.0.0' }, () => {
      server.off('error', onError);
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('could not read the port'));
    });
  });
}

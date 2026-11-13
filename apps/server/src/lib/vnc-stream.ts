import net from 'node:net';
import { WebSocket } from 'ws';
import type { VncStream } from '../computer-provider.js';

/**
 * Two ways to reach a VNC server: Orgo hands out a websockify WebSocket, a bot container runs
 * x11vnc on a loopback port. Both are wrapped in the same byte-stream shape so vnc.ts runs one
 * relay for either.
 */

/** An already-connected WebSocket to websockify. */
export function websocketVncStream(url: string): Promise<VncStream> {
  const ws = new WebSocket(url, ['binary']);
  return new Promise((resolve, reject) => {
    let opened = false;
    ws.once('open', () => {
      opened = true;
      resolve({
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close: () => {
          try { ws.close(); } catch { /* already gone */ }
        },
        onData: (cb) => ws.on('message', (data: Buffer) => cb(Buffer.from(data))),
        onClose: (cb) => {
          ws.once('close', (code) => cb(`upstream closed ${code}`));
          ws.once('error', (e) => cb(String(e?.message ?? e)));
        },
      });
    });
    ws.once('error', (e) => {
      if (!opened) reject(e);
    });
  });
}

/** An already-connected TCP socket to a VNC server on this machine. */
export function tcpVncStream(port: number, host = '127.0.0.1'): Promise<VncStream> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });
    const onError = (e: Error) => reject(e);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      socket.setNoDelay(true);
      resolve({
        send: (data) => {
          if (!socket.destroyed) socket.write(data);
        },
        close: () => socket.destroy(),
        onData: (cb) => socket.on('data', cb),
        onClose: (cb) => {
          socket.once('close', () => cb('upstream closed'));
          socket.once('error', (e) => cb(String(e?.message ?? e)));
        },
      });
    });
  });
}

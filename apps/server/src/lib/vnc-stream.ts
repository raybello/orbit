import net from 'node:net';
import type { VncStream } from '../computer-provider.js';

/** A bot container runs x11vnc on a port; vnc.ts relays this byte stream to the browser. */

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

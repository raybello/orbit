/**
 * Picking a free loopback port for the stack's web UI.
 *
 * Split from `local-stack.ts` so it can be tested (and reasoned about) without Electron,
 * docker, or the contracts package. The bind-and-release dance is the standard trick: ask
 * the OS for port 0, read what it gave us, close.
 */

import net from 'node:net';

export interface BindResult {
  port: number;
  close: () => void;
}

export type BindFn = (port: number, host: string) => Promise<BindResult>;

export const bindLoopback: BindFn = (port, host) =>
  new Promise<BindResult>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err) => reject(err));
    server.listen({ port, host, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not read the allocated port'));
        return;
      }
      resolve({ port: address.port, close: () => server.close() });
    });
  });

/**
 * A free loopback port. The retries cover the gap between releasing our probe socket and
 * docker binding the port — narrow, but the failure it prevents (a confusing compose error)
 * is worse than two extra binds.
 */
export async function allocateLoopbackPort(
  opts: { attempts?: number; bind?: BindFn; retryDelayMs?: number } = {},
): Promise<number> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const bind = opts.bind ?? bindLoopback;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await bind(0, '127.0.0.1');
      result.close();
      return result.port;
    } catch (err) {
      lastError = err;
      if (opts.retryDelayMs) await new Promise((r) => setTimeout(r, opts.retryDelayMs));
    }
  }
  throw new Error(`could not allocate a loopback port: ${(lastError as Error)?.message ?? lastError}`);
}

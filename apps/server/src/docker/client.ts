import Docker from 'dockerode';
import { env } from '../env.js';

/**
 * One Docker Engine client for the whole server. The socket comes from DOCKER_SOCKET, else
 * DOCKER_HOST (unix:///path), else Docker's default /var/run/docker.sock. Created lazily so the
 * server still starts (and Orgo bots still work) when Docker is not installed.
 */

let client: Docker | null = null;

function options(): Docker.DockerOptions {
  const socket = env.dockerSocket || '';
  if (socket.startsWith('unix://')) return { socketPath: socket.slice('unix://'.length) };
  if (socket) return { socketPath: socket };
  const host = process.env.DOCKER_HOST ?? '';
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  if (host.startsWith('tcp://')) {
    const url = new URL(host);
    return { host: url.hostname, port: Number(url.port || 2375) };
  }
  if (host) return { socketPath: host };
  return { socketPath: '/var/run/docker.sock' };
}

export function docker(): Docker {
  if (!client) client = new Docker(options());
  return client;
}

/** A short, actionable reason Docker is unusable, or null when it answers. */
export async function dockerProblem(): Promise<string | null> {
  try {
    await docker().ping();
    return null;
  } catch (e: any) {
    const where = options().socketPath ?? `${options().host}:${options().port}`;
    return `Docker is not reachable at ${where} (${e?.message ?? e}). Start Docker, or set DOCKER_SOCKET.`;
  }
}

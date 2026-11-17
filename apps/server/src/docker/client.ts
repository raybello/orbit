import Docker from 'dockerode';
import { env } from '../env.js';

/**
 * One Docker Engine client for the whole server. The socket comes from DOCKER_SOCKET, else
 * DOCKER_HOST (unix:///path, npipe://, tcp://), else Docker's default: /var/run/docker.sock, or
 * the docker_engine named pipe on Windows. Created lazily so the server still starts (and Orgo
 * bots still work) when Docker is not installed.
 */

/** What dockerode rejects with: an HTTP status from the daemon, and a message. */
export interface DockerError {
  statusCode?: number;
  message?: string;
}

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
  // Docker Desktop on Windows listens on a named pipe (DOCKER_HOST=npipe:////./pipe/docker_engine).
  if (host.startsWith('npipe://')) return { socketPath: host.slice('npipe://'.length).replace(/\//g, '\\') };
  if (host) return { socketPath: host };
  return { socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock' };
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
  } catch (e) {
    const where = options().socketPath ?? `${options().host}:${options().port}`;
    return `Docker is not reachable at ${where} (${(e as DockerError)?.message ?? e}). Start Docker, or set DOCKER_SOCKET.`;
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { docker } from './client.js';

/** The image every bot container runs. */
export const COMPUTER_IMAGE = env.computerImage;

/** Files the local build sends (see server/docker/computer). */
const BUILD_CONTEXT_FILES = ['Dockerfile', 'entrypoint.sh'];

/** Build context in the repo: server/docker/computer, next to src/ and dist/ alike. */
export const IMAGE_CONTEXT = new URL('../../docker/computer', import.meta.url).pathname;

/** Docker's rule for a name that carries its registry (host with a dot/colon/localhost). */
export function isRegistryImage(image: string): boolean {
  const slash = image.indexOf('/');
  if (slash < 0) return false;
  const host = image.slice(0, slash);
  return /[.:]/.test(host) || host === 'localhost';
}

async function exists(image: string): Promise<boolean> {
  try {
    await docker().getImage(image).inspect();
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404) return false;
    throw e;
  }
}

/** Read Docker's JSON progress stream to the end; a failed pull or build is reported as a line. */
function follow(stream: NodeJS.ReadableStream, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
          const message = event.errorDetail?.message || event.error;
          if (message) return reject(new Error(`${what}: ${message}`));
        } catch {
          // A non-JSON line is progress noise.
        }
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

let ensuring: Promise<void> | null = null;

/**
 * Make sure the computer image exists: pull a registry-qualified tag, or build an unqualified one
 * from server/docker/computer. Concurrent callers share one attempt; a failure is retried next time.
 */
export async function ensureComputerImage(): Promise<void> {
  if (await exists(COMPUTER_IMAGE)) return;
  if (ensuring) return ensuring;
  ensuring = (async () => {
    if (isRegistryImage(COMPUTER_IMAGE)) {
      console.log(`[computer] pulling ${COMPUTER_IMAGE}`);
      const stream = await docker().pull(COMPUTER_IMAGE);
      await follow(stream as unknown as NodeJS.ReadableStream, `could not pull ${COMPUTER_IMAGE}`);
    } else {
      for (const file of BUILD_CONTEXT_FILES) await fs.access(path.join(IMAGE_CONTEXT, file));
      console.log(`[computer] building ${COMPUTER_IMAGE} from ${IMAGE_CONTEXT}`);
      const stream = await docker().buildImage(
        { context: IMAGE_CONTEXT, src: BUILD_CONTEXT_FILES },
        { t: COMPUTER_IMAGE, version: '2' },
      );
      await follow(stream as unknown as NodeJS.ReadableStream, `could not build ${COMPUTER_IMAGE}`);
    }
    if (!(await exists(COMPUTER_IMAGE))) throw new Error(`${COMPUTER_IMAGE} is still missing after pulling or building it`);
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

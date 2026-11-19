/**
 * GPU voice (the audio.cpp sidecar) for the Docker stack: whether this computer can run it, and the
 * switch the person flips to install or remove it.
 *
 * The switch lives in the stack's `.env` as ORBIT_GPU_VOICE=1, next to the secrets, so it survives
 * restarts and upgrades and a person who runs the stack by hand sees it too. While it is on, every
 * compose call adds `--profile gpu` (the sidecar service is behind that profile in
 * docker-compose.images.yml) and the api is pointed at the sidecar.
 *
 * macOS never gets it: there is no CUDA there, and no Apple-silicon build of the sidecar yet, so the
 * stack pins AUDIOCPP_URL=off and the web app offers on-device voice only.
 */
import { execFile } from 'node:child_process';
import type { DesktopGpuVoice } from '@orbit/contracts';
import { classifyDockerFailure } from './docker-cli';
import { envValue, setEnvValue } from './env-file';

/** The `.env` key holding the person's choice. */
export const GPU_VOICE_KEY = 'ORBIT_GPU_VOICE';
/** Where the api reaches the sidecar on the compose network. */
export const SIDECAR_URL = 'http://audiocpp:8080';
/** The api's default when there is no sidecar: an audiocpp_server running natively on the host. */
export const HOST_AUDIOCPP_URL = 'http://host.docker.internal:8080';

export function gpuVoiceEnabled(envText: string, platform: NodeJS.Platform): boolean {
  if (platform === 'darwin') return false;
  return /^(1|true|on|yes)$/i.test(envValue(envText, GPU_VOICE_KEY) ?? '');
}

/** The compose `--profile` arguments for the current choice. */
export function gpuProfileArgs(envText: string, platform: NodeJS.Platform): string[] {
  return gpuVoiceEnabled(envText, platform) ? ['--profile', 'gpu'] : [];
}

/**
 * The `.env` with GPU voice switched on or off. AUDIOCPP_URL follows the switch, except that a URL
 * the person set themselves (a GPU box elsewhere on the LAN) is left alone while the switch is off.
 */
export function applyGpuVoice(envText: string, on: boolean, platform: NodeJS.Platform): string {
  let text = setEnvValue(envText, GPU_VOICE_KEY, on && platform !== 'darwin' ? '1' : '0');
  const current = envValue(text, 'AUDIOCPP_URL')?.trim() ?? '';
  if (platform === 'darwin') return setEnvValue(text, 'AUDIOCPP_URL', 'off');
  if (on) return setEnvValue(text, 'AUDIOCPP_URL', SIDECAR_URL);
  if (!current || current === SIDECAR_URL || current === 'off') text = setEnvValue(text, 'AUDIOCPP_URL', HOST_AUDIOCPP_URL);
  return text;
}

export type RunFile = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

const runFile: RunFile = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/**
 * The NVIDIA GPU the sidecar would run on, from `nvidia-smi` (shipped with the driver, on PATH on
 * Windows and Linux): "NVIDIA GeForce RTX 5070 Ti · 16 GB". Null when there is none.
 */
export async function detectNvidiaGpu(run: RunFile = runFile): Promise<string | null> {
  try {
    const { code, stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 10_000);
    if (code !== 0) return null;
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (!first) return null;
    const [name, mib] = first.split(',').map((s) => s.trim());
    const gb = Math.round(Number(mib) / 1024);
    return gb > 0 ? `${name} · ${gb} GB` : name;
  } catch {
    return null;
  }
}

/** The status the settings show before anything is installed. */
export function gpuVoiceSupport(platform: NodeJS.Platform, gpu: string | null, stackKind: 'docker' | 'native'): Pick<DesktopGpuVoice, 'supported' | 'reason' | 'gpu'> {
  if (platform === 'darwin') return { supported: false, reason: 'macos' };
  if (stackKind !== 'docker') return { supported: false, reason: 'not-docker-stack' };
  if (!gpu) return { supported: false, reason: 'no-nvidia' };
  return { supported: true, gpu };
}

/**
 * What to tell the person when the GPU voice image could not be pulled. Each release publishes
 * its own audiocpp image (publish-images.yml), and compiling it takes hours after the installers
 * are out, so "not found" right after a release means "not yet", not "broken".
 */
export function gpuPullError(output: string, imageTag: string, fallback: string): string {
  if (classifyDockerFailure(output) !== 'image-not-found') return fallback;
  return `GPU voice for Orbit ${imageTag} is not published yet. It is built with each release and takes a few hours after the installers appear; try again later.`;
}

/**
 * Installing Docker Desktop for the Docker stack, so a first run does not end at
 * "Docker is required".
 *
 * macOS: download Docker's DMG for this Mac's chip, mount it read-only, check that Docker.app
 * carries Docker Inc's Developer ID signature, copy it to /Applications (through macOS's
 * administrator prompt when the folder is not writable), unmount, and launch it. Docker
 * Desktop then shows its own licence and helper prompts; the stack controller waits for the
 * daemon as it already does when Docker is installed but stopped.
 *
 * Windows: download Docker's installer and start it; the installer owns elevation and WSL2.
 *
 * Every side effect is injectable, so the tests run without a network, a disk image or root.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@orbit/logger';
import {
  adminShellArgs,
  downloadVerified,
  shellQuote,
  type DownloadOptions,
  type DownloadResult,
  type ExecResult,
  type RuntimeExec,
} from './mac-runtime';
import { runDocker } from './docker-cli';

const log = createLogger({ scope: 'docker-install' });

/** The signing identity Docker Desktop for Mac ships with. */
export const DOCKER_SIGNER = 'Developer ID Application: Docker Inc';

export class DockerInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerInstallError';
  }
}

/** Docker's stable download for this platform and architecture, or null where there is none. */
export function dockerDesktopUrl(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin') {
    return `https://desktop.docker.com/mac/main/${arch === 'arm64' ? 'arm64' : 'amd64'}/Docker.dmg`;
  }
  if (platform === 'win32') {
    return `https://desktop.docker.com/win/main/${arch === 'arm64' ? 'arm64' : 'amd64'}/Docker%20Desktop%20Installer.exe`;
  }
  return null;
}

/** `codesign -dvv` output → true only for Docker Inc's Developer ID. */
export function dockerSignatureOk(codesignDetail: string): boolean {
  return codesignDetail.split('\n').some((line) => line.trim().startsWith(`Authority=${DOCKER_SIGNER}`));
}

/** The mount point `hdiutil attach -plist` reported, from its XML. */
export function mountPointFromPlist(plist: string): string | null {
  const match = plist.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  return match ? match[1] : null;
}

export interface DockerInstallOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Where the download lands; a temp folder by default. */
  workDir?: string;
  /** `/Applications` by default. */
  applicationsDir?: string;
  exec?: RuntimeExec;
  download?: (url: string, sha256: string, size: number, destPath: string, opts?: DownloadOptions) => Promise<DownloadResult>;
  onBytes?: (received: number, total: number) => void;
  canWrite?: (dir: string) => boolean;
}

const defaultExec: RuntimeExec = (binary, args, opts) => runDocker(binary, args, opts);

function text(result: ExecResult): string {
  return `${result.stderr}\n${result.stdout}`.trim().split('\n').slice(-3).join(' | ');
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download and install Docker Desktop, then launch it.
 * Resolves with the installed app (macOS) or installer (Windows) path.
 */
export async function installDockerDesktop(
  onProgress: (line: string) => void = () => {},
  opts: DockerInstallOptions = {},
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const exec = opts.exec ?? defaultExec;
  const download = opts.download ?? downloadVerified;
  const url = dockerDesktopUrl(platform, arch);
  if (!url) throw new DockerInstallError('Orbit can only install Docker Desktop on macOS and Windows. Install Docker Engine with your package manager.');

  const workDir = opts.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-docker-'));
  fs.mkdirSync(workDir, { recursive: true });

  if (platform === 'win32') {
    const installer = path.join(workDir, 'Docker Desktop Installer.exe');
    onProgress('Downloading Docker Desktop');
    await download(url, '', 0, installer, { onProgress: opts.onBytes });
    onProgress('Starting the Docker Desktop installer');
    const run = await exec(installer, ['install', '--accept-license'], { timeoutMs: 30 * 60_000 });
    if (run.code !== 0) throw new DockerInstallError(`the Docker Desktop installer failed: ${text(run)}`);
    return installer;
  }

  const dmg = path.join(workDir, 'Docker.dmg');
  onProgress(`Downloading Docker Desktop for ${arch === 'arm64' ? 'Apple silicon' : 'Intel'} Macs`);
  await download(url, '', 0, dmg, { onProgress: opts.onBytes });

  onProgress('Opening the disk image');
  const attach = await exec('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-plist', dmg], { timeoutMs: 300_000 });
  const mount = attach.code === 0 ? mountPointFromPlist(attach.stdout) : null;
  if (!mount) throw new DockerInstallError(`could not open Docker.dmg: ${text(attach)}`);

  const appsDir = opts.applicationsDir ?? '/Applications';
  const target = path.join(appsDir, 'Docker.app');
  try {
    const source = path.join(mount, 'Docker.app');
    onProgress('Checking Docker’s signature');
    const detail = await exec('codesign', ['-dvv', source], { timeoutMs: 120_000 });
    const verify = await exec('codesign', ['--verify', '--strict', source], { timeoutMs: 600_000 });
    if (verify.code !== 0 || !dockerSignatureOk(`${detail.stdout}\n${detail.stderr}`)) {
      throw new DockerInstallError(`refusing to install a Docker.app that Docker Inc did not sign: ${text(verify)}`);
    }

    onProgress(`Copying Docker to ${appsDir}`);
    const canWrite = opts.canWrite ?? writable;
    const copy = canWrite(appsDir)
      ? await exec('ditto', [source, target], { timeoutMs: 900_000 })
      : await exec(
          'osascript',
          adminShellArgs(`/usr/bin/ditto ${shellQuote(source)} ${shellQuote(target)}`, 'Orbit wants to install Docker Desktop in Applications.'),
          { timeoutMs: 900_000 },
        );
    if (copy.code !== 0) throw new DockerInstallError(`could not copy Docker.app: ${text(copy)}`);
  } finally {
    const detach = await exec('hdiutil', ['detach', mount, '-quiet'], { timeoutMs: 120_000 });
    if (detach.code !== 0) log.warn(`hdiutil detach ${mount}: ${text(detach)}`);
    fs.rmSync(dmg, { force: true });
  }

  onProgress('Starting Docker Desktop (accept its licence when it asks)');
  const open = await exec('open', ['-a', target], { timeoutMs: 60_000 });
  if (open.code !== 0) log.warn(`open -a ${target}: ${text(open)}`);
  return target;
}

/**
 * The native Mac stack's runtime: eligibility, the signed server bundle, and the optional
 * Apple container runtime for bot VMs.
 *
 * Orbit's server is Node + SQLite, so "running natively" means one downloaded tarball of
 * `apps/server/dist` + `apps/web/dist` and no database service to boot. Everything here is
 * about getting that tarball onto disk safely: the download is hashed while it streams, the
 * manifest that describes it ships inside the `.app`, and extraction goes through `tar`
 * rather than a Node library so we add no dependency.
 *
 * Every side effect that reaches the network, a subprocess or the filesystem is injectable.
 * The unit tests drive this module with an local http server and a fake `tar`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { createLogger } from '@orbit/logger';
import { runDocker } from './docker-cli';

const log = createLogger({ scope: 'mac-runtime' });

// ------------------------------------------------------------------ eligibility

export interface RuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  /** `os.release()`: the Darwin kernel version, e.g. `25.6.0` for macOS 26. */
  release: string;
}

/**
 * macOS 26 is Darwin 25. The native path needs macOS 26's container/VM tooling and the
 * process supervision it enables; below that, Docker Compose is the supported stack.
 */
export const MIN_DARWIN_MAJOR = 25;

export function nativeStackEligible(runtime: Partial<RuntimeInfo> = {}): boolean {
  const platform = runtime.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  const arch = runtime.arch ?? process.arch;
  if (arch !== 'arm64') return false;
  const release = runtime.release ?? os.release();
  const major = parseInt(String(release).split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= MIN_DARWIN_MAJOR;
}

/** Why the native stack is unavailable, for the menu and the logs. */
export function ineligibilityReason(runtime: Partial<RuntimeInfo> = {}): string | null {
  if (nativeStackEligible(runtime)) return null;
  const platform = runtime.platform ?? process.platform;
  const arch = runtime.arch ?? process.arch;
  if (platform !== 'darwin') return 'the native stack is macOS only';
  if (arch !== 'arm64') return 'the native stack needs Apple Silicon';
  return `the native stack needs macOS 26 (Darwin ${MIN_DARWIN_MAJOR}) or later`;
}

// ------------------------------------------------------------------ manifest

/**
 * `Resources/server-bundle.json`, embedded in the `.app`.
 *
 * `migrate` is optional: a bundle whose server creates its schema on boot (Orbit's does,
 * with `CREATE TABLE IF NOT EXISTS`) ships none. When it *is* declared, the file has to be
 * there — a missing one is a broken bundle, not a version difference.
 */
export interface ServerManifest {
  version: string;
  download: { url: string; sha256: string; size: number };
  entrypoints: {
    /** Relative to the bundle root, e.g. `dist/index.js`. */
    api: string;
    /** Relative to the bundle root, e.g. `dist/migrate.js`. */
    migrate?: string;
    /** A separate static server, when the bundle has one. Rare: the API serves web. */
    web?: string;
  };
}

export const SERVER_BUNDLE_FILE = 'server-bundle.json';

/** Parse and validate a manifest; `null` when the file is absent or unusable. */
export function readServerManifest(file: string): ServerManifest | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn(`${file} is not valid JSON`, err);
    return null;
  }
  return validateServerManifest(parsed);
}

export function validateServerManifest(input: unknown): ServerManifest | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Partial<ServerManifest>;
  const version = typeof value.version === 'string' ? value.version.trim() : '';
  const url = typeof value.download?.url === 'string' ? value.download.url.trim() : '';
  const api = typeof value.entrypoints?.api === 'string' ? value.entrypoints.api.trim() : '';
  if (!version || !url || !api) return null;
  return {
    version,
    download: {
      url,
      sha256: String(value.download?.sha256 ?? '').trim().toLowerCase(),
      size: Number(value.download?.size ?? 0) || 0,
    },
    entrypoints: {
      api,
      ...(value.entrypoints?.migrate ? { migrate: String(value.entrypoints.migrate) } : {}),
      ...(value.entrypoints?.web ? { web: String(value.entrypoints.web) } : {}),
    },
  };
}

/** `userData/server-bundles`: one directory per installed version, plus `current`. */
export function serverBundleDir(userDataDir: string): string {
  return path.join(userDataDir, 'server-bundles');
}

// ------------------------------------------------------------------ subprocesses

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type RuntimeExec = (binary: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** tar, codesign, shasum: all the same "run it, capture output, never throw on exit code". */
const defaultExec: RuntimeExec = (binary, args, opts) => runDocker(binary, args, opts);

function execText(result: ExecResult): string {
  return `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 300))
    .slice(-4)
    .join(' | ');
}

// ------------------------------------------------------------------ download

export type DownloadFailure = 'http' | 'network' | 'short-read' | 'overflow' | 'hash';

export class DownloadVerifyError extends Error {
  constructor(
    message: string,
    readonly kind: DownloadFailure,
    readonly detail: { expected?: string; actual?: string; expectedSize?: number; received?: number } = {},
  ) {
    super(message);
    this.name = 'DownloadVerifyError';
  }
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  /** A hung connection must not hang first run forever. */
  timeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  size: number;
}

/**
 * Stream `url` to `destPath`, hashing as it goes.
 *
 * The bytes land in `<destPath>.tmp` and are renamed into place only after the length and
 * the digest both match, so a half-written bundle can never look installed. A mismatch
 * removes the temp file: retrying is then a clean download rather than a resume of garbage.
 */
export async function downloadVerified(
  url: string,
  sha256: string,
  size: number,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tmpPath = `${destPath}.tmp`;
  const expectedHash = String(sha256 ?? '').trim().toLowerCase();
  const expectedSize = Number.isFinite(size) ? Math.max(0, Math.trunc(Number(size))) : 0;

  fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
  removeFile(tmpPath);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30 * 60_000),
    });
  } catch (err) {
    throw new DownloadVerifyError(`could not download ${url}: ${errorText(err)}`, 'network');
  }
  if (!response.ok) {
    throw new DownloadVerifyError(`${url} answered HTTP ${response.status}`, 'http');
  }
  if (!response.body) {
    throw new DownloadVerifyError(`${url} returned an empty body`, 'http');
  }

  const hash = createHash('sha256');
  let received = 0;
  const out = fs.createWriteStream(tmpPath, { mode: 0o600 });

  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (expectedSize > 0 && received > expectedSize) {
        throw new DownloadVerifyError(
          `${url} sent more than the ${expectedSize} bytes the manifest declares`,
          'overflow',
          { expectedSize, received },
        );
      }
      hash.update(buf);
      opts.onProgress?.(received, expectedSize);
      if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    await finished(out.end());
  } catch (err) {
    out.destroy();
    removeFile(tmpPath);
    if (err instanceof DownloadVerifyError) throw err;
    throw new DownloadVerifyError(`download of ${url} failed: ${errorText(err)}`, 'network');
  }

  if (expectedSize > 0 && received !== expectedSize) {
    removeFile(tmpPath);
    throw new DownloadVerifyError(
      `${url} ended after ${received} of ${expectedSize} bytes`,
      'short-read',
      { expectedSize, received },
    );
  }

  const digest = hash.digest('hex');
  if (expectedHash && digest !== expectedHash) {
    removeFile(tmpPath);
    throw new DownloadVerifyError(
      `sha256 mismatch for ${url}: expected ${expectedHash}, got ${digest}`,
      'hash',
      { expected: expectedHash, actual: digest },
    );
  }

  fs.renameSync(tmpPath, destPath);
  return { path: destPath, sha256: digest, size: received };
}

// ------------------------------------------------------------------ bundle install

export interface BundleInstallOptions {
  /** Injected in tests: a local http server instead of the release URL. */
  download?: (
    url: string,
    sha256: string,
    size: number,
    destPath: string,
    opts?: DownloadOptions,
  ) => Promise<DownloadResult>;
  exec?: RuntimeExec;
  exists?: (file: string) => boolean;
  onProgress?: (line: string) => void;
  onBytes?: (received: number, total: number) => void;
  /** How many versions to keep on disk, newest first. */
  keep?: number;
}

export interface InstalledBundle {
  version: string;
  /** `userData/server-bundles/orbit-server-<version>` */
  dir: string;
  /** `userData/server-bundles/current`, a relative symlink. */
  current: string;
  /** False when the version was already on disk. */
  downloaded: boolean;
}

export class BundleInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleInstallError';
  }
}

/**
 * Download, verify and unpack `manifest` into `destDir`.
 *
 * Idempotent: if the version's `dist/index.js` is already there, this only refreshes the
 * `current` symlink and prunes. Callers can therefore call it on every launch.
 */
export async function installServerBundle(
  manifest: ServerManifest,
  destDir: string,
  opts: BundleInstallOptions = {},
): Promise<InstalledBundle> {
  const exists = opts.exists ?? ((file: string) => fs.existsSync(file));
  const exec = opts.exec ?? defaultExec;
  const download = opts.download ?? downloadVerified;
  const progress = opts.onProgress ?? (() => {});

  const version = manifest.version;
  if (!version || !manifest.download?.url || !manifest.entrypoints?.api) {
    throw new BundleInstallError('the server manifest is missing version, download.url or entrypoints.api');
  }

  const targetDir = path.join(destDir, `orbit-server-${version}`);
  const currentLink = path.join(destDir, 'current');
  const apiEntry = path.join(targetDir, manifest.entrypoints.api);

  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });

  if (exists(apiEntry)) {
    pointCurrentAt(destDir, targetDir);
    pruneServerBundles(destDir, opts.keep ?? 2);
    return { version, dir: targetDir, current: currentLink, downloaded: false };
  }

  const archive = path.join(destDir, `.orbit-server-${version}.tar.xz`);
  progress(`Downloading Orbit server ${version}`);
  await download(manifest.download.url, manifest.download.sha256, manifest.download.size, archive, {
    onProgress: opts.onBytes,
  });

  const staging = path.join(destDir, `.staging-${version}-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });

  progress(`Unpacking Orbit server ${version}`);
  try {
    const result = await exec('tar', ['-xJf', archive, '-C', staging], { timeoutMs: 600_000 });
    if (result.code !== 0) {
      throw new BundleInstallError(`tar could not unpack ${path.basename(archive)}: ${execText(result)}`);
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    removeFile(archive);
    throw err;
  }
  removeFile(archive);

  // A tarball built with `.` at its root unpacks straight into staging; one built around a
  // top-level directory has exactly one entry, and that is the bundle root. Decide by where
  // the API entrypoint actually is, not by counting directories (`dist/` is a directory too).
  const bundleRoot = exists(path.join(staging, manifest.entrypoints.api))
    ? staging
    : (() => {
        const only = singleDirectory(staging);
        return only && exists(path.join(only, manifest.entrypoints.api)) ? only : null;
      })();
  if (!bundleRoot) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new BundleInstallError(
      `the Orbit server bundle unpacked without ${manifest.entrypoints.api}; ` +
        'the release artifact does not match server-bundle.json',
    );
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  if (bundleRoot === staging) fs.renameSync(staging, targetDir);
  else {
    fs.renameSync(bundleRoot, targetDir);
    fs.rmSync(staging, { recursive: true, force: true });
  }

  pointCurrentAt(destDir, targetDir);
  const pruned = pruneServerBundles(destDir, opts.keep ?? 2);
  progress(`Installed Orbit server ${version}`);
  log.info(`installed server bundle ${version} in ${targetDir}${pruned.length ? ` (pruned ${pruned.length})` : ''}`);
  return { version, dir: targetDir, current: currentLink, downloaded: true };
}

/** `current` -> `orbit-server-<version>`, relative so the whole folder can move. */
function pointCurrentAt(destDir: string, targetDir: string): void {
  const link = path.join(destDir, 'current');
  try {
    const stat = fs.lstatSync(link);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      // An older build copied a whole tree here instead of linking; do not lose it silently.
      log.warn(`${link} is a directory, not a symlink; leaving it alone`);
      return;
    }
    fs.unlinkSync(link);
  } catch {
    /* no link yet */
  }
  try {
    fs.symlinkSync(path.relative(destDir, targetDir), link, 'dir');
  } catch (err) {
    // Windows and locked-down filesystems: a link is a convenience, not a requirement.
    log.warn('could not write the current symlink', err);
  }
}

/** Remove old `orbit-server-*` directories, newest `keep` survive (never `current`). */
export function pruneServerBundles(destDir: string, keep = 2, reserved: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(destDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const currentTarget = (() => {
    try {
      return fs.realpathSync(path.join(destDir, 'current'));
    } catch {
      return null;
    }
  })();

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('orbit-server-'))
    .map((entry) => {
      const full = path.join(destDir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        /* raced with another prune */
      }
      return { name: entry.name, full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed: string[] = [];
  // Compare by *name*: `realpathSync` turns /var into /private/var on macOS, and the
  // candidates are all in this one directory anyway.
  const protectedNames = new Set<string>(reserved.map((dir) => path.basename(dir)));
  if (currentTarget) protectedNames.add(path.basename(currentTarget));

  for (const [index, candidate] of candidates.entries()) {
    if (index < Math.max(1, keep)) continue;
    if (protectedNames.has(candidate.name)) continue;
    try {
      fs.rmSync(candidate.full, { recursive: true, force: true });
      removed.push(candidate.name);
    } catch (err) {
      log.warn(`could not prune ${candidate.full}`, err);
    }
  }
  return removed;
}

// ------------------------------------------------------------------ container runtime

/**
 * Apple's container CLI is only needed to run bot VMs (Docker-format images). The Orbit
 * server itself needs nothing: SQLite is a file and the API is Node.
 */
export const CONTAINER_RUNTIME_VERSION = '1.7.1';

/** Exactly what Apple's Developer ID-signed releases say in the certificate chain. */
export const EXPECTED_RUNTIME_SIGNER = 'Developer ID Application: Apple Inc.';

export interface ContainerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  homeDir?: string;
}

/** Where Apple's installer puts things, plus the launcher's documented paths. */
export function containerRuntimeCandidates(opts: ContainerRuntimeOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? os.homedir();
  return [
    env.ORBIT_CONTAINER_BIN ?? '',
    '/usr/local/bin/container',
    '/opt/homebrew/bin/container',
    path.join(home, 'Library', 'Containers', 'com.apple.container', 'bin', 'container'),
    '/usr/bin/container',
  ].filter(Boolean);
}

export function resolveContainerRuntime(opts: ContainerRuntimeOptions = {}): string | null {
  const exists = opts.exists ?? ((file: string) => fs.existsSync(file));
  for (const candidate of containerRuntimeCandidates(opts)) {
    const bare = !candidate.includes('/');
    if (bare) return candidate;
    if (exists(candidate)) return candidate;
  }
  return null;
}

export interface SignatureCheck {
  ok: boolean;
  signer?: string;
  teamId?: string;
  detail: string;
}

/**
 * `codesign` is the only signature check that means anything here: the download has no
 * checksum we control, so the guarantee is "Apple signed it", not "the bytes match our
 * manifest". `--deep` covers the helper binaries in the same pass.
 */
export async function verifyRuntimeSignature(
  binaryPath: string,
  opts: { exec?: RuntimeExec; expectedSigner?: string } = {},
): Promise<SignatureCheck> {
  const exec = opts.exec ?? defaultExec;
  const expected = opts.expectedSigner ?? EXPECTED_RUNTIME_SIGNER;

  const verify = await exec('codesign', ['--verify', '--deep', '--strict', binaryPath]);
  if (verify.code !== 0) {
    return { ok: false, detail: `codesign --verify failed: ${execText(verify)}` };
  }

  const display = await exec('codesign', ['-dv', '--verbose=4', binaryPath]);
  // codesign writes this report to stderr, whatever the exit code.
  const report = `${display.stderr}\n${display.stdout}`;
  const signer = /^Authority=(.+)$/m.exec(report)?.[1]?.trim();
  const teamId = /^TeamIdentifier=(.+)$/m.exec(report)?.[1]?.trim();
  if (!signer) {
    return { ok: false, teamId, detail: 'the binary is signed but reports no Authority line' };
  }
  if (!signer.includes(expected)) {
    return { ok: false, signer, teamId, detail: `signed by "${signer}", not "${expected}"` };
  }
  return { ok: true, signer, teamId, detail: `signed by ${signer}` };
}

export interface ContainerInstallOptions {
  exec?: RuntimeExec;
  exists?: (file: string) => boolean;
  download?: (
    url: string,
    sha256: string,
    size: number,
    destPath: string,
    opts?: DownloadOptions,
  ) => Promise<DownloadResult>;
  /** `~/Library/Containers/com.apple.container` by default. */
  installRoot?: string;
  /** Binaries are copied here when the release has no installer script. */
  prefixDir?: string;
  verify?: (binaryPath: string) => Promise<SignatureCheck>;
  env?: NodeJS.ProcessEnv;
}

export function containerInstallRoot(opts: ContainerInstallOptions = {}): string {
  return opts.installRoot ?? path.join(os.homedir(), 'Library', 'Containers', 'com.apple.container');
}

export function containerReleaseUrl(version: string): string {
  return `https://github.com/apple/container/releases/download/${version}/container-${version}-installer-signed.tar`;
}

/**
 * Install Apple's container CLI from its signed installer release.
 *
 * There is no checksum we host, so the signature *is* the verification: unpack, verify
 * with `codesign`, and only then run the installer script (which asks for admin rights).
 */
export async function installContainerRuntime(
  version: string = CONTAINER_RUNTIME_VERSION,
  onProgress: (line: string) => void = () => {},
  opts: ContainerInstallOptions = {},
): Promise<string> {
  const exists = opts.exists ?? ((file: string) => fs.existsSync(file));
  const exec = opts.exec ?? defaultExec;
  const download = opts.download ?? downloadVerified;
  const verify = opts.verify ?? ((binary: string) => verifyRuntimeSignature(binary, { exec }));
  const installRoot = containerInstallRoot(opts);
  const prefix = opts.prefixDir ?? '/usr/local/bin';

  fs.mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  const archive = path.join(installRoot, `container-${version}-installer.tar`);

  onProgress(`Downloading Apple container ${version}`);
  await download(containerReleaseUrl(version), '', 0, archive);

  const extractDir = path.join(installRoot, `container-${version}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  const untar = await exec('tar', ['-xf', archive, '-C', extractDir], { timeoutMs: 600_000 });
  if (untar.code !== 0) {
    throw new BundleInstallError(`could not unpack the container installer: ${execText(untar)}`);
  }
  removeFile(archive);

  const roots = [extractDir, singleDirectory(extractDir)].filter((candidate): candidate is string => !!candidate);
  const binary = roots
    .flatMap((root) => ['bin/container', 'container'].map((rel) => path.join(root, rel)))
    .find(exists);
  if (!binary) {
    throw new BundleInstallError(`the container installer unpacked without a container binary in ${extractDir}`);
  }
  const root = roots.find((candidate) => binary.startsWith(`${candidate}${path.sep}`)) ?? extractDir;

  onProgress('Verifying the Apple signature');
  const signature = await verify(binary);
  if (!signature.ok) {
    throw new BundleInstallError(`refusing to install an unsigned container runtime: ${signature.detail}`);
  }

  const script = path.join(root, 'install-container.sh');
  onProgress('Installing (macOS will ask for your password)');
  if (exists(script)) {
    const install = await exec('bash', [script, '-d', prefix], { timeoutMs: 600_000 });
    if (install.code !== 0) {
      throw new BundleInstallError(`the container installer failed: ${execText(install)}`);
    }
  } else {
    // No script in the archive: the signed binaries are all there is to install.
    fs.mkdirSync(prefix, { recursive: true });
    for (const name of fs.readdirSync(path.join(root, 'bin'))) {
      const from = path.join(root, 'bin', name);
      const to = path.join(prefix, name);
      fs.copyFileSync(from, to);
      fs.chmodSync(to, 0o755);
    }
  }

  onProgress(`Apple container ${version} installed`);
  return resolveContainerRuntime({ env: opts.env }) ?? path.join(prefix, 'container');
}

// ------------------------------------------------------------------ helpers

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** The one directory inside `dir`, when that is all there is. */
function singleDirectory(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((entry) => entry.isDirectory());
  return dirs.length === 1 && entries.length === 1 ? path.join(dir, dirs[0].name) : null;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

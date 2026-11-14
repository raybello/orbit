/**
 * Finding, installing and wiring Hermes — the agent harness every Orbit bot runs on.
 *
 * Everything here takes its filesystem, process runner, HTTP client and HOME as arguments
 * (defaulting to the real ones), because this code runs behind a setup window with a
 * progress log: it has to be testable without a network or a real Hermes install, and a
 * failure has to be a readable line rather than a stack trace.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { parseDocument } from 'yaml';
import type { HermesStatus } from './shared/api';
import { envValue, setEnvValue } from './env-file';

export const HERMES_RELEASES_URL = 'https://api.github.com/repos/NousResearch/hermes-agent/releases/latest';
export const HERMES_DOCS_URL = 'https://github.com/NousResearch/hermes-agent#install';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HermesDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests; defaults to `os.homedir()`. */
  home?: string;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
  /** Write with an explicit mode; the caller owns 0600. */
  writeFile?: (file: string, text: string, mode?: number) => void;
  mkdirp?: (dir: string) => void;
  exec?: (command: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;
  fetchImpl?: typeof fetch;
  tmpDir?: string;
  log?: (line: string) => void;
}

interface ResolvedDeps extends Required<Omit<HermesDeps, 'log'>> {
  log: (line: string) => void;
}

function resolveDeps(deps: HermesDeps): ResolvedDeps {
  const env = deps.env ?? process.env;
  return {
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    env,
    home: deps.home ?? os.homedir(),
    exists: deps.exists ?? ((file) => fs.existsSync(file)),
    readFile: deps.readFile ?? ((file) => fs.readFileSync(file, 'utf8')),
    writeFile:
      deps.writeFile ??
      ((file, text, mode) => {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, text, { encoding: 'utf8', mode: mode ?? 0o600 });
      }),
    mkdirp: deps.mkdirp ?? ((dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 })),
    exec: deps.exec ?? defaultExec,
    fetchImpl: deps.fetchImpl ?? fetch,
    tmpDir: deps.tmpDir ?? os.tmpdir(),
    log: deps.log ?? (() => {}),
  };
}

function defaultExec(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    nodeExecFile(
      command,
      args,
      { timeout: opts.timeoutMs ?? 60_000, env: opts.env ?? process.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** `~/.hermes`, or `%APPDATA%\hermes` on Windows, unless HERMES_HOME says otherwise. */
export function hermesHome(env: NodeJS.ProcessEnv = process.env, deps: HermesDeps = {}): string {
  // Callers pass either an env object or `deps.env`; merge so both spellings work.
  const effective: NodeJS.ProcessEnv = { ...(deps.env ?? {}), ...env };
  const resolved = resolveDeps({ ...deps, env: effective });
  const override = effective.HERMES_HOME?.trim();
  if (override) return override;
  if (resolved.platform === 'win32') {
    const appData = effective.APPDATA?.trim() || path.join(resolved.home, 'AppData', 'Roaming');
    return path.join(appData, 'hermes');
  }
  return path.join(resolved.home, '.hermes');
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'hermes.exe' : 'hermes';
}

/** The places a Hermes install lands, in the order we look. */
export function hermesCandidates(
  env: NodeJS.ProcessEnv,
  deps: HermesDeps = {},
): string[] {
  const resolved = resolveDeps({ ...deps, env });
  const effective: NodeJS.ProcessEnv = { ...(deps.env ?? {}), ...env };
  const exe = binaryName(resolved.platform);
  const home = hermesHome(env, deps);
  const candidates = [
    effective.HERMES_BIN?.trim() || '',
    path.join(home, 'bin', exe),
    resolved.platform === 'win32' ? '' : '/usr/local/bin/hermes',
    resolved.platform === 'win32' ? '' : '/opt/homebrew/bin/hermes',
    path.join(resolved.home, '.local', 'bin', exe),
  ];
  return candidates.filter(Boolean);
}

function firstVersion(text: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  return match ? match[1] : null;
}

/**
 * Detect an existing Hermes.
 *
 * `HERMES_BIN` wins, then the usual install paths; a candidate only counts once
 * `--version` answers, so a stale symlink does not send the setup window down a broken
 * path.
 */
export async function detectHermes(
  env: NodeJS.ProcessEnv = process.env,
  deps: HermesDeps = {},
): Promise<HermesStatus> {
  const resolved = resolveDeps({ ...deps, env });
  const home = hermesHome(env, deps);
  const apiKey = readHermesApiKey(env, deps);

  for (const candidate of hermesCandidates(env, deps)) {
    if (!resolved.exists(candidate)) continue;
    const result = await resolved.exec(candidate, ['--version'], { timeoutMs: 15_000 });
    if (result.code !== 0) {
      resolved.log(`${candidate} exists but \`--version\` failed`);
      continue;
    }
    const version = firstVersion(`${result.stdout}\n${result.stderr}`);
    return {
      found: true,
      version: version ?? undefined,
      home,
      hasApiKey: !!apiKey,
      binaryPath: candidate,
    };
  }

  return { found: false, home, hasApiKey: !!apiKey };
}

function readHermesApiKey(env: NodeJS.ProcessEnv = process.env, deps: HermesDeps = {}): string | null {
  const resolved = resolveDeps({ ...deps, env });
  const envPath = path.join(hermesHome(env, deps), '.env');
  try {
    if (!resolved.exists(envPath)) return null;
    return envValue(resolved.readFile(envPath), 'API_SERVER_KEY');
  } catch {
    return null;
  }
}

/** Reject values that are not a bare 64-char lowercase hex digest. */
export function pickSha256(shaFileText: string): string | null {
  const match = /\b([a-f0-9]{64})\b/i.exec(shaFileText ?? '');
  return match ? match[1].toLowerCase() : null;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * A release asset name we are willing to turn into a path.
 *
 * The name comes from a GitHub API response, and it is used both as a file name inside a temp
 * directory and in a shell command line. `../../evil.sh` would write outside that directory
 * and `x; rm -rf /` would be command injection if it were interpolated, so anything that is
 * not a bare, safe-looking file name is refused outright rather than sanitised silently.
 */
export function safeAssetName(name: string): string {
  const raw = String(name ?? '').trim();
  const base = path.posix.basename(raw.replace(/\\/g, '/'));
  const safe = /^[A-Za-z0-9._-]+$/.test(base) && base !== '.' && base !== '..';
  if (!raw || base !== raw || !safe) {
    throw new Error(
      `refusing an unsafe release asset name (${JSON.stringify(raw)}): ` +
        'expected a plain file name of letters, digits, dot, dash or underscore',
    );
  }
  return base;
}

/** The env var the Windows extractor reads its two paths from, never the command text. */
export const WINDOWS_EXTRACT_ENV = { archive: 'ORBIT_HERMES_ZIP', destination: 'ORBIT_HERMES_DEST' } as const;

/** `Expand-Archive` with the paths in the environment, so no name is ever spliced into code. */
export const WINDOWS_EXTRACT_SCRIPT =
  `Expand-Archive -LiteralPath $env:${WINDOWS_EXTRACT_ENV.archive} ` +
  `-DestinationPath $env:${WINDOWS_EXTRACT_ENV.destination} -Force`;

/**
 * How to unpack an archive on this platform.
 *
 * Windows has no `unzip`, so it goes through PowerShell — but the invocation is an argv array
 * plus environment, not a `-Command` string built by concatenation: a name with a quote or a
 * semicolon in it is data here, and can only ever be data.
 */
export function extractionCommand(
  archivePath: string,
  destination: string,
  platform: NodeJS.Platform,
): { command: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (/\.[jt]ar\.gz$|\.tgz$/i.test(archivePath)) {
    return { command: 'tar', args: ['-xzf', archivePath, '-C', destination] };
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_EXTRACT_SCRIPT],
      env: { ...process.env, [WINDOWS_EXTRACT_ENV.archive]: archivePath, [WINDOWS_EXTRACT_ENV.destination]: destination },
    };
  }
  return { command: 'unzip', args: ['-o', '-q', archivePath, '-d', destination] };
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

/** Choose the archive for this platform, preferring the exact arch name. */
export function pickReleaseAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): { archive: ReleaseAsset; checksum?: ReleaseAsset } | null {
  const platformToken =
    platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : platform;
  const archTokens =
    arch === 'arm64' ? ['arm64', 'aarch64'] : arch === 'x64' ? ['x64', 'amd64'] : [arch, 'x86_64'];
  const archPattern = new RegExp(archTokens.join('|'), 'i');
  const platformPattern = new RegExp(`(?:${platformToken}|${platform === 'win32' ? 'win' : platformToken})`, 'i');

  const archives = assets.filter((a) => /\.(tar\.gz|tgz|zip)$/i.test(a.name));
  const exact = archives.find((a) => platformPattern.test(a.name) && archPattern.test(a.name));
  const loose = archives.find((a) => platformPattern.test(a.name));
  const archive = exact ?? loose;
  if (!archive) return null;
  const checksum =
    assets.find((a) => a.name === `${archive.name}.sha256`) ??
    assets.find((a) => a.name === `${archive.name}.sha256sum`) ??
    assets.find((a) => /\.sha256$/i.test(a.name) && a.name.includes(path.basename(archive.name, path.extname(archive.name)).split('.')[0]));
  return { archive, checksum };
}

export interface InstallHermesOptions {
  /** Where the release archive is downloaded; removed afterwards. */
  tmpDir?: string;
  /** Allow installs when the release publishes no `.sha256`. Off by default. */
  allowUnverified?: boolean;
  onProgress?: (line: string) => void;
}

/**
 * Download, verify, unpack and initialise Hermes.
 *
 * Progress is line-oriented and monotonic, because it lands in a scrolling pane in the
 * setup window; failures throw with the line the user needs to read.
 */
export async function installHermes(
  onProgress: (line: string) => void = () => {},
  deps: HermesDeps = {},
  options: InstallHermesOptions = {},
): Promise<HermesStatus> {
  const resolved = resolveDeps(deps);
  const say = (line: string) => {
    resolved.log(line);
    try {
      (options.onProgress ?? onProgress)(line);
    } catch {
      /* a closed setup window must not abort the install */
    }
  };

  const platform = resolved.platform;
  const home = hermesHome(resolved.env, deps);
  say(`Looking up the latest Hermes release for ${platform}-${resolved.arch}…`);

  const releaseRes = await resolved.fetchImpl(HERMES_RELEASES_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'orbit-desktop' },
  });
  if (!releaseRes.ok) {
    throw new Error(`GitHub Releases answered ${releaseRes.status} for ${HERMES_RELEASES_URL}`);
  }
  const release = (await releaseRes.json()) as { tag_name?: string; assets?: ReleaseAsset[] };
  const assets = release.assets ?? [];
  const picked = pickReleaseAsset(assets, platform, resolved.arch);
  if (!picked) {
    throw new Error(`No Hermes release archive published for ${platform}-${resolved.arch}`);
  }
  // Refuse a hostile name before anything is downloaded or written.
  const assetName = safeAssetName(picked.archive.name);
  say(`Downloading ${assetName}${release.tag_name ? ` (${release.tag_name})` : ''}…`);

  const archiveRes = await resolved.fetchImpl(picked.archive.browser_download_url, {
    headers: { 'user-agent': 'orbit-desktop' },
    redirect: 'follow',
  });
  if (!archiveRes.ok) {
    throw new Error(`Downloading ${picked.archive.name} failed: HTTP ${archiveRes.status}`);
  }
  const bytes = new Uint8Array(await archiveRes.arrayBuffer());

  if (picked.checksum) {
    say('Verifying the SHA-256 checksum…');
    const shaRes = await resolved.fetchImpl(picked.checksum.browser_download_url, {
      headers: { 'user-agent': 'orbit-desktop' },
      redirect: 'follow',
    });
    if (!shaRes.ok) throw new Error(`Downloading ${picked.checksum.name} failed: HTTP ${shaRes.status}`);
    const expected = pickSha256(await shaRes.text());
    if (!expected) throw new Error(`${picked.checksum.name} does not contain a SHA-256 digest`);
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${picked.archive.name} (expected ${expected}, got ${actual})`);
    }
    say('Checksum verified.');
  } else if (!options.allowUnverified && resolved.env.ORBIT_SKIP_HERMES_CHECKSUM !== '1') {
    throw new Error(
      `The ${picked.archive.name} release publishes no .sha256 checksum; refusing to install unverified code. ` +
        'Set ORBIT_SKIP_HERMES_CHECKSUM=1 to override.',
    );
  } else {
    say('Warning: no checksum published for this release; skipping verification.');
  }

  const workDir = path.join(options.tmpDir ?? resolved.tmpDir, `orbit-hermes-${process.pid}-${Date.now()}`);
  resolved.mkdirp(workDir);
  const archivePath = path.join(workDir, assetName);
  fs.writeFileSync(archivePath, bytes, { mode: 0o600 });

  resolved.mkdirp(home);
  say(`Extracting into ${home}…`);
  const unpack = await extractArchive(archivePath, home, resolved);
  if (unpack.code !== 0) {
    throw new Error(`Extracting ${assetName} failed: ${unpack.stderr.split('\n')[0] || unpack.code}`);
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* temp */
  }

  const binary = path.join(home, 'bin', binaryName(platform));
  if (!resolved.exists(binary)) {
    // Some archives nest a versioned directory; look one level down before giving up.
    const nested = findBinary(home, binaryName(platform), 2);
    if (!nested) {
      throw new Error(`Hermes unpacked but ${binary} is missing; the release layout changed.`);
    }
    say(`Found the binary at ${nested}`);
  }

  say('Updating your shell PATH…');
  updateShellProfile(home, resolved);

  say('Running `hermes init`…');
  const init = await resolved.exec(binary, ['init'], { timeoutMs: 120_000 });
  if (init.code !== 0) {
    // init failing is not fatal: the app can still start the stack, and the user may
    // prefer to run it themselves once their keys are in place.
    say(`\`hermes init\` exited ${init.code}: ${(init.stderr || init.stdout).split('\n')[0]}`);
  }

  say('Hermes installed.');
  return detectHermes(resolved.env, deps);
}

function findBinary(root: string, name: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findBinary(path.join(root, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

async function extractArchive(archivePath: string, destination: string, deps: ResolvedDeps): Promise<ExecResult> {
  const { command, args, env } = extractionCommand(archivePath, destination, deps.platform);
  return deps.exec(command, args, { timeoutMs: 300_000, ...(env ? { env } : {}) });
}

/** Append our bin dir to the profile the user's shell actually reads, once. */
export function shellProfilePaths(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const documents = env.USERPROFILE ? path.join(env.USERPROFILE, 'Documents') : path.join(home, 'Documents');
    return [
      path.join(documents, 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(documents, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ];
  }
  if (platform === 'darwin') {
    return [path.join(home, '.zshrc'), path.join(home, '.bashrc'), path.join(home, '.profile')];
  }
  return [path.join(home, '.bashrc'), path.join(home, '.profile'), path.join(home, '.zshrc')];
}

export function pathLine(platform: NodeJS.Platform, home: string): string {
  if (platform === 'win32') {
    return `$env:Path = "${path.join(home, 'bin')};" + $env:Path`;
  }
  return `export PATH="${path.join(home, 'bin')}:$PATH"`;
}

function updateShellProfile(home: string, deps: ResolvedDeps): void {
  const line = pathLine(deps.platform, home);
  const marker = '# Orbit: Hermes CLI';
  for (const profile of shellProfilePaths(deps.platform, deps.home, deps.env)) {
    let existing = '';
    try {
      if (deps.exists(profile)) existing = deps.readFile(profile);
    } catch {
      continue;
    }
    if (existing.includes(line)) return;
    const addition = `${existing.endsWith('\n') || existing === '' ? '' : '\n'}${marker}\n${line}\n`;
    try {
      deps.writeFile(profile, `${existing}${addition}`, 0o644);
      return;
    } catch {
      // A missing ~/Documents/PowerShell directory is normal on a fresh Windows profile.
    }
  }
}

// ------------------------------------------------------------------ MCP wiring

export interface WireMcpOptions {
  /** Defaults to `http://127.0.0.1:8787`, i.e. the local stack. */
  serverUrl?: string;
  /** Defaults to `/mcp`, which is where routes.ts mounts the agent-facing server. */
  mcpPath?: string;
  configPath?: string;
}

/**
 * Add (or refresh) `mcp_servers.orbit` in `~/.hermes/config.yaml`.
 *
 * Read-modify-write with the `yaml` document API: a round-trip through a plain object
 * would drop comments and reorder the file the user maintains by hand.
 */
export function wireHermesMcp(
  token: string,
  deps: HermesDeps = {},
  options: WireMcpOptions = {},
): { configPath: string; url: string } {
  const resolved = resolveDeps(deps);
  const configPath = options.configPath ?? path.join(hermesHome(resolved.env, deps), 'config.yaml');
  const base = (options.serverUrl ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const url = `${base}${options.mcpPath ?? '/mcp'}`;

  const existing = resolved.exists(configPath) ? resolved.readFile(configPath) : '';
  const doc = parseDocument(existing || '{}');
  if (doc.errors.length > 0) {
    throw new Error(
      `~/.hermes/config.yaml is not valid YAML (${doc.errors[0].message}). ` +
        `Fix it by hand or move it aside; Orbit will not rewrite a file it cannot parse.`,
    );
  }

  doc.setIn(['mcp_servers', 'orbit'], {
    type: 'http',
    url,
    headers: { Authorization: `Bearer ${token}` },
  });

  const text = doc.toString({ lineWidth: 0 });
  resolved.writeFile(configPath, text, 0o600);
  resolved.log(`wired mcp_servers.orbit -> ${url}`);
  return { configPath, url };
}

// ------------------------------------------------------------------ API key

export interface EnsureApiKeyOptions {
  /** The stack's `.env`; HERMES_KEY is mirrored there for the server to read. */
  stackEnvPath?: string;
  generate?: () => string;
}

/**
 * Guarantee `~/.hermes/.env` carries API_SERVER_KEY, and mirror it as HERMES_KEY in the
 * stack `.env` so the server can reach the agent's API.
 */
export function ensureHermesApiKey(
  deps: HermesDeps = {},
  options: EnsureApiKeyOptions = {},
): { key: string; generated: boolean; envPath: string } {
  const resolved = resolveDeps(deps);
  const envPath = path.join(hermesHome(resolved.env, deps), '.env');
  const generate = options.generate ?? (() => randomBytes(32).toString('hex'));

  const existingText = resolved.exists(envPath) ? resolved.readFile(envPath) : '';
  const current = envValue(existingText, 'API_SERVER_KEY');
  const key = current ?? generate();
  if (!current) {
    resolved.writeFile(envPath, setEnvValue(existingText, 'API_SERVER_KEY', key), 0o600);
    resolved.log('generated API_SERVER_KEY in ~/.hermes/.env');
  }

  if (options.stackEnvPath) {
    try {
      const stackText = resolved.exists(options.stackEnvPath) ? resolved.readFile(options.stackEnvPath) : '';
      if (envValue(stackText, 'HERMES_KEY') !== key) {
        fs.mkdirSync(path.dirname(options.stackEnvPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(options.stackEnvPath, setEnvValue(stackText, 'HERMES_KEY', key), {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
    } catch (err) {
      // The stack may not exist yet; the server falls back to ~/.hermes/.env.
      resolved.log(`could not mirror HERMES_KEY into the stack env: ${(err as Error).message}`);
    }
  }

  return { key, generated: !current, envPath };
}

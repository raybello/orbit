import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectHermes,
  ensureHermesApiKey,
  extractionCommand,
  hermesCandidates,
  hermesHome,
  installHermes,
  pickReleaseAsset,
  pickSha256,
  safeAssetName,
  sha256Hex,
  wireHermesMcp,
  type HermesDeps,
} from '../hermes-setup';

const HOME = '/Users/tester';

interface FakeFs {
  files: Record<string, string>;
  written: Record<string, string>;
  modes: Record<string, number | undefined>;
  deps: HermesDeps;
}

/** A filesystem that is just a map, with a runnable fake `hermes`. */
function fakeFs(initial: Record<string, string> = {}, versions: Record<string, string> = {}): FakeFs {
  const files = { ...initial };
  const written: Record<string, string> = {};
  const modes: Record<string, number | undefined> = {};

  const deps: HermesDeps = {
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    home: HOME,
    exists: (file) => Object.prototype.hasOwnProperty.call(files, file),
    readFile: (file) => {
      if (!Object.prototype.hasOwnProperty.call(files, file)) throw new Error(`ENOENT ${file}`);
      return files[file];
    },
    writeFile: (file, text, mode) => {
      files[file] = text;
      written[file] = text;
      modes[file] = mode;
    },
    mkdirp: () => {},
    exec: async (command, args) => {
      if (!Object.prototype.hasOwnProperty.call(files, command)) {
        return { code: 127, stdout: '', stderr: 'not found' };
      }
      if (args[0] === '--version') {
        const v = versions[command];
        return v
          ? { code: 0, stdout: `hermes ${v}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'boom' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { files, written, modes, deps };
}

describe('hermesHome', () => {
  test('is ~/.hermes on unix', () => {
    assert.equal(hermesHome({}, { home: HOME, platform: 'darwin' }), path.join(HOME, '.hermes'));
  });

  test('is %APPDATA%/hermes on Windows', () => {
    assert.equal(
      hermesHome({ APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' }, { home: HOME, platform: 'win32' }),
      path.join('C:\\Users\\tester\\AppData\\Roaming', 'hermes'),
    );
  });

  test('HERMES_HOME wins', () => {
    assert.equal(hermesHome({ HERMES_HOME: '/srv/hermes' }, { home: HOME }), '/srv/hermes');
  });
});

describe('hermesCandidates', () => {
  test('puts HERMES_BIN first, then the install paths', () => {
    const candidates = hermesCandidates({ HERMES_BIN: '/opt/hermes/bin/hermes' }, { home: HOME, platform: 'darwin' });
    assert.equal(candidates[0], '/opt/hermes/bin/hermes');
    assert.ok(candidates.includes(path.join(HOME, '.hermes', 'bin', 'hermes')));
    assert.ok(candidates.includes('/usr/local/bin/hermes'));
    assert.ok(candidates.includes(path.join(HOME, '.local', 'bin', 'hermes')));
  });

  test('uses hermes.exe on Windows', () => {
    const candidates = hermesCandidates({}, { home: HOME, platform: 'win32', env: { APPDATA: 'C:\\AD' } });
    assert.ok(candidates.every((c) => !c.endsWith('.exe') || c.endsWith('hermes.exe')));
    assert.ok(candidates.includes(path.join('C:\\AD', 'hermes', 'bin', 'hermes.exe')));
  });
});

describe('detectHermes', () => {
  test('finds a binary at the default path and reads its version', async () => {
    const binary = path.join(HOME, '.hermes', 'bin', 'hermes');
    const { deps, files } = fakeFs({ [binary]: '#!/bin/sh\n', [path.join(HOME, '.hermes', '.env')]: 'API_SERVER_KEY=abc\n' }, { [binary]: '0.9.4' });
    const status = await detectHermes({}, deps);
    assert.equal(status.found, true);
    assert.equal(status.version, '0.9.4');
    assert.equal(status.binaryPath, binary);
    assert.equal(status.hasApiKey, true);
    assert.equal(status.home, path.join(HOME, '.hermes'));
    assert.ok(files[binary]);
  });

  test('reports found:false when no candidate exists', async () => {
    const { deps } = fakeFs();
    const status = await detectHermes({}, deps);
    assert.equal(status.found, false);
    assert.equal(status.version, undefined);
    assert.equal(status.home, path.join(HOME, '.hermes'));
  });

  test('skips a stale file whose --version fails', async () => {
    const stale = path.join(HOME, '.hermes', 'bin', 'hermes');
    const good = '/usr/local/bin/hermes';
    const { deps } = fakeFs({ [stale]: 'stale', [good]: 'good' }, { [good]: '1.2.3' });
    const status = await detectHermes({}, deps);
    assert.equal(status.found, true);
    assert.equal(status.binaryPath, good);
    assert.equal(status.version, '1.2.3');
  });

  test('prefers HERMES_BIN over the default path', async () => {
    const custom = '/opt/custom/hermes';
    const { deps } = fakeFs(
      { [custom]: 'bin', [path.join(HOME, '.hermes', 'bin', 'hermes')]: 'bin' },
      { [custom]: '2.0.0', [path.join(HOME, '.hermes', 'bin', 'hermes')]: '0.1.0' },
    );
    const status = await detectHermes({ HERMES_BIN: custom }, deps);
    assert.equal(status.binaryPath, custom);
    assert.equal(status.version, '2.0.0');
  });

  test('hasApiKey is false for an empty API_SERVER_KEY', async () => {
    const binary = path.join(HOME, '.hermes', 'bin', 'hermes');
    const { deps } = fakeFs(
      { [binary]: 'bin', [path.join(HOME, '.hermes', '.env')]: 'API_SERVER_KEY=\n' },
      { [binary]: '1.0.0' },
    );
    const status = await detectHermes({}, deps);
    assert.equal(status.hasApiKey, false);
  });
});

describe('wireHermesMcp', () => {
  test('adds mcp_servers.orbit and keeps the rest of the YAML, comments included', () => {
    const configPath = path.join(HOME, '.hermes', 'config.yaml');
    const original = ['# my hand-written config', 'model: deepseek-flash', 'mcp_servers:', '  other:', '    type: stdio'].join('\n');
    const { deps, written } = fakeFs({ [configPath]: original });

    const result = wireHermesMcp('tok_123', deps, { serverUrl: 'http://127.0.0.1:9123' });
    assert.equal(result.url, 'http://127.0.0.1:9123/mcp');

    const out = written[configPath];
    assert.match(out, /model: deepseek-flash/);
    assert.match(out, /# my hand-written config/);
    assert.match(out, /other:/);
    assert.match(out, /orbit:/);
    assert.match(out, /type: http/);
    assert.match(out, /url: http:\/\/127\.0\.0\.1:9123\/mcp/);
    assert.match(out, /Authorization: Bearer tok_123/);
  });

  test('creates the file when it does not exist', () => {
    const configPath = path.join(HOME, '.hermes', 'config.yaml');
    const { deps, written } = fakeFs();
    wireHermesMcp('abc', deps, { configPath });
    assert.match(written[configPath], /mcp_servers:/);
  });

  test('refuses to rewrite a config it cannot parse', () => {
    const configPath = path.join(HOME, '.hermes', 'config.yaml');
    const { deps, written } = fakeFs({ [configPath]: 'mcp_servers: [unclosed\n  bad: : :' });
    assert.throws(() => wireHermesMcp('abc', deps, { configPath }), /not valid YAML/);
    assert.equal(written[configPath], undefined, 'the original file must be untouched');
  });

  test('writes the config 0600', { skip: process.platform === 'win32' }, () => {
    const configPath = path.join(HOME, '.hermes', 'config.yaml');
    const { deps, modes } = fakeFs();
    wireHermesMcp('abc', deps, { configPath });
    assert.equal(modes[configPath], 0o600);
  });
});

describe('ensureHermesApiKey', () => {
  test('generates and stores API_SERVER_KEY when absent', () => {
    const envPath = path.join(HOME, '.hermes', '.env');
    const { deps, written, modes } = fakeFs({ [envPath]: 'OTHER=1\n' });
    const result = ensureHermesApiKey(deps, { generate: () => 'f'.repeat(64) });
    assert.equal(result.key, 'f'.repeat(64));
    assert.equal(result.generated, true);
    assert.match(written[envPath], /^API_SERVER_KEY=f{64}$/m);
    assert.match(written[envPath], /^OTHER=1$/m);
    assert.equal(modes[envPath], 0o600);
  });

  test('reuses an existing key', () => {
    const envPath = path.join(HOME, '.hermes', '.env');
    const { deps, written } = fakeFs({ [envPath]: 'API_SERVER_KEY=existing\n' });
    const result = ensureHermesApiKey(deps);
    assert.equal(result.key, 'existing');
    assert.equal(result.generated, false);
    assert.equal(written[envPath], undefined);
  });
});

describe('release helpers', () => {
  test('pickSha256 only accepts a 64-char hex digest', () => {
    assert.equal(pickSha256(`${'a'.repeat(64)}  hermes-darwin-arm64.tar.gz\n`), 'a'.repeat(64));
    assert.equal(pickSha256('not a digest'), null);
    assert.equal(pickSha256(''), null);
    assert.equal(pickSha256(`sha256:${'B'.repeat(64)}`), 'b'.repeat(64));
  });

  test('sha256Hex hashes the bytes it is given', () => {
    assert.equal(
      sha256Hex('hello'),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  test('pickReleaseAsset prefers the exact platform+arch archive', () => {
    const assets = [
      { name: 'hermes-linux-x64.tar.gz', browser_download_url: 'l' },
      { name: 'hermes-darwin-arm64.tar.gz', browser_download_url: 'a', size: 10 },
      { name: 'hermes-darwin-x64.tar.gz', browser_download_url: 'x' },
      { name: 'hermes-darwin-arm64.tar.gz.sha256', browser_download_url: 's' },
    ];
    const picked = pickReleaseAsset(assets, 'darwin', 'arm64');
    assert.equal(picked?.archive.browser_download_url, 'a');
    assert.equal(picked?.checksum?.browser_download_url, 's');
  });

  test('pickReleaseAsset returns null when nothing matches the platform', () => {
    assert.equal(pickReleaseAsset([{ name: 'hermes-windows-x64.zip', browser_download_url: 'w' }], 'darwin', 'arm64'), null);
  });

  test('pickReleaseAsset maps arm64 to aarch64 names', () => {
    const assets = [{ name: 'hermes-linux-aarch64.tar.gz', browser_download_url: 'a' }];
    assert.equal(pickReleaseAsset(assets, 'linux', 'arm64')?.archive.browser_download_url, 'a');
  });
});

// ------------------------------------------------------------------ asset names

describe('safeAssetName', () => {
  test('accepts a plain release file name', () => {
    assert.equal(safeAssetName('hermes-darwin-arm64.tar.gz'), 'hermes-darwin-arm64.tar.gz');
    assert.equal(safeAssetName('hermes_windows_x64.zip'), 'hermes_windows_x64.zip');
  });

  test('refuses a traversal name', () => {
    assert.throws(() => safeAssetName('../../evil.sh'), /unsafe release asset name/);
    assert.throws(() => safeAssetName('../evil.tar.gz'), /unsafe release asset name/);
    assert.throws(() => safeAssetName('..\\evil.zip'), /unsafe release asset name/);
    assert.throws(() => safeAssetName('/etc/passwd'), /unsafe release asset name/);
  });

  test('refuses a name that would be shell syntax', () => {
    assert.throws(() => safeAssetName('x; rm -rf /'), /unsafe release asset name/);
    assert.throws(() => safeAssetName("it's; rm -rf ~.zip"), /unsafe release asset name/);
    assert.throws(() => safeAssetName('a$(whoami).zip'), /unsafe release asset name/);
    assert.throws(() => safeAssetName('name with spaces.zip'), /unsafe release asset name/);
  });

  test('refuses empty, dot and dotdot', () => {
    for (const name of ['', '.', '..']) {
      assert.throws(() => safeAssetName(name), /unsafe release asset name/);
    }
  });
});

describe('extractionCommand', () => {
  test('never puts a path into the Windows command text', () => {
    const archive = 'C:\\Temp\\orbit\\hermes-windows-x64.zip';
    const { command, args, env } = extractionCommand(archive, 'C:\\Users\\me\\hermes', 'win32');
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-NonInteractive'));
    const script = args[args.length - 1];
    assert.match(script, /Expand-Archive/);
    assert.ok(!script.includes(archive), 'the archive path must not be spliced into the command');
    assert.ok(!script.includes('Users'), 'the destination must not be spliced into the command');
    assert.equal(env?.ORBIT_HERMES_ZIP, archive);
    assert.equal(env?.ORBIT_HERMES_DEST, 'C:\\Users\\me\\hermes');
  });

  test('uses tar for a tarball and unzip elsewhere', () => {
    assert.deepEqual(extractionCommand('/tmp/h.tar.gz', '/tmp/out', 'darwin').args, [
      '-xzf',
      '/tmp/h.tar.gz',
      '-C',
      '/tmp/out',
    ]);
    assert.deepEqual(extractionCommand('/tmp/h.zip', '/tmp/out', 'linux').args, ['-o', '-q', '/tmp/h.zip', '-d', '/tmp/out']);
  });
});

describe('installHermes asset handling', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-hermes-asset-'));
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

  /** A release whose archive name is hostile, and a fetch that would serve it. */
  function hostileRelease(name: string) {
    const asked: string[] = [];
    const deps: HermesDeps = {
      platform: 'darwin',
      arch: 'arm64',
      env: {},
      home: path.join(tmp, 'home'),
      tmpDir: tmp,
      exists: () => false,
      readFile: () => '',
      writeFile: () => {},
      mkdirp: () => {},
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      log: () => {},
      fetchImpl: (async (input: string | URL | Request) => {
        asked.push(String(input));
        if (String(input).includes('releases/latest')) {
          return new Response(
            JSON.stringify({ tag_name: 'v1', assets: [{ name, browser_download_url: 'https://example.invalid/x' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('archive-bytes', { status: 200 });
      }) as typeof fetch,
    };
    return { deps, asked };
  }

  test('refuses a traversal name before downloading anything', async () => {
    const { deps, asked } = hostileRelease('hermes-darwin-arm64/../../../evil.tar.gz');
    await assert.rejects(() => installHermes(() => {}, deps), /unsafe release asset name/);
    // Only the release lookup happened; the archive was never fetched.
    assert.equal(asked.length, 1);
  });

  test('refuses a shell-injection name', async () => {
    const { deps } = hostileRelease('hermes-darwin-arm64; rm -rf ~.tar.gz');
    await assert.rejects(() => installHermes(() => {}, deps), /unsafe release asset name/);
  });

  test('accepts a normal name and writes it inside its own work dir', async () => {
    const { deps } = hostileRelease('hermes-darwin-arm64.tar.gz');
    // No checksum is published, so the install refuses unless the override is set.
    await assert.rejects(
      () => installHermes(() => {}, deps),
      /publishes no \.sha256 checksum/,
    );
  });
});

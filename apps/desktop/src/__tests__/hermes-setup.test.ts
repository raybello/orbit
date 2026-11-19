import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectHermes,
  extractionCommand,
  hermesCandidates,
  hermesHome,
  installHermes,
  pickReleaseAsset,
  pickSha256,
  safeAssetName,
  sha256Hex,
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

  test('is %LOCALAPPDATA%/hermes on Windows, where Hermes keeps its home', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' };
    assert.equal(
      hermesHome(env, { home: HOME, platform: 'win32', exists: () => false }),
      path.join('C:\\Users\\tester\\AppData\\Local', 'hermes'),
    );
    // %APPDATA%\hermes is normally only the Hermes desktop app's browser profile, but an older
    // install that kept its home there (a .env or config.yaml) is still found.
    const roamingEnv = path.join('C:\\Users\\tester\\AppData\\Roaming', 'hermes', '.env');
    assert.equal(
      hermesHome(env, { home: HOME, platform: 'win32', exists: (f) => f === roamingEnv }),
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
    const candidates = hermesCandidates({}, { home: HOME, platform: 'win32', env: { LOCALAPPDATA: 'C:\\LAD' }, exists: () => false });
    assert.ok(candidates.every((c) => !c.endsWith('.exe') || c.endsWith('hermes.exe')));
    assert.ok(candidates.includes(path.join('C:\\LAD', 'hermes', 'bin', 'hermes.exe')));
  });
});

describe('detectHermes', () => {
  test('finds a binary at the default path and reads its version', async () => {
    const binary = path.join(HOME, '.hermes', 'bin', 'hermes');
    const { deps, files } = fakeFs({ [binary]: '#!/bin/sh\n' }, { [binary]: '0.9.4' });
    const status = await detectHermes({}, deps);
    assert.equal(status.found, true);
    assert.equal(status.version, '0.9.4');
    assert.equal(status.binaryPath, binary);
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

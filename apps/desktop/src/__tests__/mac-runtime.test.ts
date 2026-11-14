import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  BundleInstallError,
  CONTAINER_RUNTIME_VERSION,
  DownloadVerifyError,
  downloadVerified,
  ineligibilityReason,
  installServerBundle,
  nativeStackEligible,
  pruneServerBundles,
  resolveContainerRuntime,
  validateServerManifest,
  verifyRuntimeSignature,
  type ServerManifest,
} from '../mac-runtime';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mac-runtime-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A throwaway directory per test, so no two assertions share a tree. */
function tmpDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------------ eligibility

describe('nativeStackEligible', () => {
  test('accepts Apple Silicon on Darwin 25 and later', () => {
    assert.equal(nativeStackEligible({ platform: 'darwin', arch: 'arm64', release: '25.0.0' }), true);
    assert.equal(nativeStackEligible({ platform: 'darwin', arch: 'arm64', release: '25.6.0' }), true);
    assert.equal(nativeStackEligible({ platform: 'darwin', arch: 'arm64', release: '26.1.0' }), true);
  });

  test('rejects macOS 15 (Darwin 24) and older', () => {
    assert.equal(nativeStackEligible({ platform: 'darwin', arch: 'arm64', release: '24.6.0' }), false);
    assert.equal(nativeStackEligible({ platform: 'darwin', arch: 'arm64', release: '23.0.0' }), false);
    assert.equal(ineligibilityReason({ platform: 'darwin', arch: 'arm64', release: '24.6.0' }), 'the native stack needs macOS 26 (Darwin 25) or later');
  });

  test('rejects Intel Macs', () => {
    assert.equal(nativeStackEligible({ platform: 'darwin', arch: 'x64', release: '25.0.0' }), false);
    assert.equal(ineligibilityReason({ platform: 'darwin', arch: 'x64', release: '25.0.0' }), 'the native stack needs Apple Silicon');
  });

  test('rejects everything that is not macOS', () => {
    for (const platform of ['win32', 'linux', 'freebsd'] as const) {
      assert.equal(nativeStackEligible({ platform, arch: 'arm64', release: '25.0.0' }), false);
    }
    assert.equal(ineligibilityReason({ platform: 'linux', arch: 'arm64', release: '25.0.0' }), 'the native stack is macOS only');
  });

  test('treats an unparseable kernel version as ineligible', () => {
    assert.equal(nativeStackEligible({ platform: 'darwin', arch: 'arm64', release: 'Darwin' }), false);
  });

  test('without arguments it reads the real runtime', () => {
    // This machine is macOS 26 arm64 (see PART6_REPORT.md); the check must not throw anywhere.
    assert.equal(typeof nativeStackEligible(), 'boolean');
  });
});

// ------------------------------------------------------------------ manifest

describe('validateServerManifest', () => {
  const base = { version: '0.1.0', download: { url: 'https://x/y.tar.xz', sha256: 'AB', size: 12 }, entrypoints: { api: 'dist/index.js' } };

  test('accepts a complete manifest and normalises the digest', () => {
    const manifest = validateServerManifest(base);
    assert.deepEqual(manifest, {
      version: '0.1.0',
      download: { url: 'https://x/y.tar.xz', sha256: 'ab', size: 12 },
      entrypoints: { api: 'dist/index.js' },
    });
  });

  test('keeps an optional migrate entrypoint and drops it when absent', () => {
    const withMigrate = validateServerManifest({ ...base, entrypoints: { api: 'dist/index.js', migrate: 'dist/migrate.js' } });
    assert.equal(withMigrate?.entrypoints.migrate, 'dist/migrate.js');
    assert.equal(validateServerManifest(base)?.entrypoints.migrate, undefined);
  });

  test('rejects anything missing what the installer needs', () => {
    assert.equal(validateServerManifest(null), null);
    assert.equal(validateServerManifest('nope'), null);
    assert.equal(validateServerManifest({ ...base, version: '' }), null);
    assert.equal(validateServerManifest({ ...base, download: { url: '', sha256: '', size: 0 } }), null);
    assert.equal(validateServerManifest({ ...base, entrypoints: {} }), null);
  });
});

// ------------------------------------------------------------------ download

/** Serve `body` over loopback http and hand back its URL. */
async function serve(body: Buffer, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/orbit-server.tar.xz`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('downloadVerified', () => {
  const body = Buffer.from('orbit-server-'.repeat(4_096));
  const digest = createHash('sha256').update(body).digest('hex');

  test('downloads a real file over http and verifies it byte for byte', async () => {
    const origin = await serve(body);
    const dir = tmpDir('download-ok');
    const dest = path.join(dir, 'orbit-server.tar.xz');
    let progress = 0;

    try {
      const result = await downloadVerified(origin.url, digest, body.length, dest, {
        onProgress: (received, total) => {
          progress = Math.max(progress, received);
          assert.equal(total, body.length);
        },
      });
      assert.equal(result.sha256, digest);
      assert.equal(result.size, body.length);
      assert.deepEqual(fs.readFileSync(dest), body);
      assert.equal(progress, body.length);
      // Nothing left behind: the temp file was renamed into place.
      assert.equal(fs.existsSync(`${dest}.tmp`), false);
      assert.deepEqual(fs.readdirSync(dir), ['orbit-server.tar.xz']);
    } finally {
      await origin.close();
    }
  });

  test('throws DownloadVerifyError on a hash mismatch and leaves no .tmp', async () => {
    const origin = await serve(body);
    const dir = tmpDir('download-bad-hash');
    const dest = path.join(dir, 'orbit-server.tar.xz');
    const wrong = '0'.repeat(64);

    try {
      await assert.rejects(
        () => downloadVerified(origin.url, wrong, body.length, dest),
        (err: unknown) => {
          assert.ok(err instanceof DownloadVerifyError);
          assert.equal(err.kind, 'hash');
          assert.match(err.message, /sha256 mismatch/);
          assert.equal(err.detail.actual, digest);
          return true;
        },
      );
      assert.equal(fs.existsSync(dest), false);
      assert.equal(fs.existsSync(`${dest}.tmp`), false);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      await origin.close();
    }
  });

  test('rejects a short read when the declared size is larger', async () => {
    const origin = await serve(body);
    const dir = tmpDir('download-short');
    const dest = path.join(dir, 'orbit-server.tar.xz');
    try {
      await assert.rejects(
        () => downloadVerified(origin.url, digest, body.length + 10, dest),
        (err: unknown) => {
          assert.ok(err instanceof DownloadVerifyError);
          assert.equal(err.kind, 'short-read');
          return true;
        },
      );
      assert.equal(fs.existsSync(`${dest}.tmp`), false);
    } finally {
      await origin.close();
    }
  });

  test('reports an http failure without writing anything', async () => {
    const origin = await serve(Buffer.from('not found'), 404);
    const dir = tmpDir('download-404');
    const dest = path.join(dir, 'orbit-server.tar.xz');
    try {
      await assert.rejects(
        () => downloadVerified(origin.url, digest, body.length, dest),
        (err: unknown) => err instanceof DownloadVerifyError && err.kind === 'http',
      );
      assert.equal(fs.existsSync(dest), false);
    } finally {
      await origin.close();
    }
  });

  test('reports an unreachable host as a network failure', async () => {
    const dir = tmpDir('download-refused');
    await assert.rejects(
      () => downloadVerified('http://127.0.0.1:1/nothing.tar.xz', digest, 1, path.join(dir, 'x.tar.xz'), { timeoutMs: 2_000 }),
      (err: unknown) => err instanceof DownloadVerifyError && err.kind === 'network',
    );
  });
});

// ------------------------------------------------------------------ bundle install

/**
 * A fake `tar`: instead of an archive, it writes the tree the test expects to find, so the
 * install path (staging, rename, symlink, prune) is exercised without xz or 40MB of files.
 */
function fakeTar(files: Record<string, string>) {
  const calls: string[][] = [];
  const exec = async (
    binary: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    calls.push([binary, ...args]);
    assert.equal(binary, 'tar');
    const target = args[args.indexOf('-C') + 1];
    assert.ok(target, 'tar must be given -C');
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(target, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('installServerBundle', () => {
  const manifest: ServerManifest = {
    version: '0.1.0',
    download: { url: 'https://example.invalid/orbit-server-0.1.0.tar.xz', sha256: 'a'.repeat(64), size: 1234 },
    entrypoints: { api: 'dist/index.js', migrate: 'dist/migrate.js' },
  };

  test('downloads, unpacks, links current, and is a no-op the second time', async () => {
    const dest = tmpDir('bundles');
    const downloads: string[] = [];
    const download = async (
      _url: string,
      _sha: string,
      _size: number,
      destPath: string,
    ): Promise<{ path: string; sha256: string; size: number }> => {
      downloads.push(destPath);
      fs.writeFileSync(destPath, 'pretend-tarball');
      return { path: destPath, sha256: 'a'.repeat(64), size: 14 };
    };
    const { exec, calls } = fakeTar({ 'dist/index.js': '// api', 'dist/migrate.js': '// migrate' });
    const lines: string[] = [];

    const first = await installServerBundle(manifest, dest, { download, exec, onProgress: (line) => lines.push(line) });
    assert.equal(first.downloaded, true);
    assert.equal(first.version, '0.1.0');
    assert.equal(first.dir, path.join(dest, 'orbit-server-0.1.0'));
    assert.equal(fs.readFileSync(path.join(first.dir, 'dist', 'index.js'), 'utf8'), '// api');

    // `current` is a relative symlink, so the whole folder can move.
    const link = path.join(dest, 'current');
    assert.equal(fs.readlinkSync(link), 'orbit-server-0.1.0');
    assert.equal(fs.realpathSync(link), fs.realpathSync(first.dir));

    // The tarball is unpacked with xz support and removed afterwards.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['tar', '-xJf']);
    assert.equal(fs.readdirSync(dest).filter((name) => name.endsWith('.tar.xz')).length, 0);
    assert.match(lines.join('\n'), /Downloading Orbit server 0\.1\.0/);
    assert.match(lines.join('\n'), /Installed Orbit server 0\.1\.0/);

    const second = await installServerBundle(manifest, dest, { download, exec });
    assert.equal(second.downloaded, false);
    assert.equal(downloads.length, 1, 'an installed version must not be downloaded again');
    assert.equal(calls.length, 1, 'an installed version must not be unpacked again');
  });

  test('unwraps a tarball built around a single top-level directory', async () => {
    const dest = tmpDir('bundles-wrapped');
    const download = async (_u: string, _s: string, _z: number, destPath: string) => {
      fs.writeFileSync(destPath, 'x');
      return { path: destPath, sha256: '', size: 1 };
    };
    const { exec } = fakeTar({ 'orbit-server-0.1.0/dist/index.js': '// wrapped' });
    const installed = await installServerBundle(manifest, dest, { download, exec });
    assert.equal(fs.readFileSync(path.join(installed.dir, 'dist', 'index.js'), 'utf8'), '// wrapped');
  });

  test('fails loudly when the tarball has no API entrypoint', async () => {
    const dest = tmpDir('bundles-empty');
    const download = async (_u: string, _s: string, _z: number, destPath: string) => {
      fs.writeFileSync(destPath, 'x');
      return { path: destPath, sha256: '', size: 1 };
    };
    const { exec } = fakeTar({ 'README.md': 'wrong artifact' });
    await assert.rejects(
      () => installServerBundle(manifest, dest, { download, exec }),
      (err: unknown) => err instanceof BundleInstallError && /without dist\/index\.js/.test(err.message),
    );
    assert.equal(fs.existsSync(path.join(dest, 'orbit-server-0.1.0')), false);
    assert.deepEqual(
      fs.readdirSync(dest).filter((name) => name.startsWith('.staging')),
      [],
      'a failed unpack must not leave staging directories behind',
    );
  });

  test('surfaces tar failures with the command output', async () => {
    const dest = tmpDir('bundles-tar-fail');
    const download = async (_u: string, _s: string, _z: number, destPath: string) => {
      fs.writeFileSync(destPath, 'x');
      return { path: destPath, sha256: '', size: 1 };
    };
    const exec = async () => ({ code: 1, stdout: '', stderr: 'xz: (stdin): File format not recognized' });
    await assert.rejects(
      () => installServerBundle(manifest, dest, { download, exec }),
      (err: unknown) => err instanceof BundleInstallError && /File format not recognized/.test(err.message),
    );
  });
});

describe('pruneServerBundles', () => {
  function makeVersion(dest: string, version: string, mtimeMs: number): string {
    const dir = path.join(dest, `orbit-server-${version}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), version);
    fs.utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
    return dir;
  }

  test('keeps the newest N and never the current target', () => {
    const dest = tmpDir('prune');
    const oldest = makeVersion(dest, '0.0.1', 1_000_000);
    const middle = makeVersion(dest, '0.1.0', 2_000_000);
    const newest = makeVersion(dest, '0.2.0', 3_000_000);
    fs.symlinkSync('orbit-server-0.0.1', path.join(dest, 'current'), 'dir');

    const removed = pruneServerBundles(dest, 1);

    // keep=1 would drop everything but `newest`, except `current` points at the oldest.
    assert.deepEqual(removed, ['orbit-server-0.1.0']);
    assert.equal(fs.existsSync(oldest), true);
    assert.equal(fs.existsSync(middle), false);
    assert.equal(fs.existsSync(newest), true);
  });

  test('keeps two by default and survives a missing directory', () => {
    const dest = tmpDir('prune-default');
    for (const [version, mtime] of [['0.0.1', 1_000_000], ['0.1.0', 2_000_000], ['0.2.0', 3_000_000]] as const) {
      makeVersion(dest, version, mtime);
    }
    assert.deepEqual(pruneServerBundles(dest).sort(), ['orbit-server-0.0.1']);
    assert.deepEqual(pruneServerBundles(path.join(dest, 'nope')), []);
  });
});

// ------------------------------------------------------------------ container runtime

describe('container runtime', () => {
  test('is pinned to the version the native docs name', () => {
    assert.equal(CONTAINER_RUNTIME_VERSION, '1.7.1');
  });

  test('resolveContainerRuntime looks in the usual places and honours an override', () => {
    assert.equal(resolveContainerRuntime({ exists: () => false, homeDir: '/Users/x', env: {} }), null);
    assert.equal(
      resolveContainerRuntime({ exists: (file) => file === '/opt/homebrew/bin/container', homeDir: '/Users/x', env: {} }),
      '/opt/homebrew/bin/container',
    );
    const override = resolveContainerRuntime({
      exists: (file) => file === '/custom/container',
      homeDir: '/Users/x',
      env: { ORBIT_CONTAINER_BIN: '/custom/container' },
    });
    assert.equal(override, '/custom/container');
  });

  function codesignExec(verifyCode: number, report: string) {
    const calls: string[][] = [];
    const exec = async (binary: string, args: string[]) => {
      calls.push([binary, ...args]);
      if (args[0] === '--verify') return { code: verifyCode, stdout: '', stderr: verifyCode === 0 ? '' : 'code object is not signed at all' };
      return { code: 0, stdout: '', stderr: report };
    };
    return { exec, calls };
  }

  test('accepts a binary signed by Apple and reports the team id', async () => {
    const { exec, calls } = codesignExec(
      0,
      'Executable=/usr/local/bin/container\nIdentifier=com.apple.container\nAuthority=Developer ID Application: Apple Inc. (ABCDE12345)\nTeamIdentifier=ABCDE12345',
    );
    const result = await verifyRuntimeSignature('/usr/local/bin/container', { exec });
    assert.equal(result.ok, true);
    assert.equal(result.teamId, 'ABCDE12345');
    assert.match(result.signer ?? '', /Apple Inc\./);
    assert.deepEqual(calls[0], ['codesign', '--verify', '--deep', '--strict', '/usr/local/bin/container']);
  });

  test('rejects an unsigned binary and a third-party signer', async () => {
    const unsigned = codesignExec(1, '');
    assert.equal((await verifyRuntimeSignature('/x', { exec: unsigned.exec })).ok, false);

    const thirdParty = codesignExec(0, 'Authority=Developer ID Application: Someone Else (ZZZZ)\nTeamIdentifier=ZZZZ');
    const result = await verifyRuntimeSignature('/x', { exec: thirdParty.exec });
    assert.equal(result.ok, false);
    assert.match(result.detail, /not "Developer ID Application: Apple Inc\./);
  });
});

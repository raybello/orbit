import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTAINER_RUNTIME_SHA256,
  CONTAINER_RUNTIME_VERSION,
  adminShellArgs,
  containerReleaseUrl,
  installContainerRuntime,
  packageSignatureOk,
  shellQuote,
  type ExecResult,
} from '../mac-runtime';
import { dockerDesktopUrl, dockerSignatureOk, installDockerDesktop, mountPointFromPlist } from '../docker-install';

/** These flows only ever run on macOS, and their fixtures are POSIX paths. */
const macOnly = { skip: process.platform === 'win32' ? 'macOS-only install flow' : false };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-deps-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

/** Real `pkgutil --check-signature` output for container-1.7.1-installer-signed.pkg. */
const APPLE_PKG_SIGNATURE = `Package "c.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Certificate Chain:
    1. Developer ID Installer: Apple Inc. - Containerization (UPBK2H6LZM)`;

describe('Apple container runtime', () => {
  test('points at the signed .pkg Apple actually publishes, with a pinned digest', () => {
    assert.equal(
      containerReleaseUrl('1.7.1'),
      'https://github.com/apple/container/releases/download/1.7.1/container-1.7.1-installer-signed.pkg',
    );
    assert.match(CONTAINER_RUNTIME_SHA256[CONTAINER_RUNTIME_VERSION] ?? '', /^[0-9a-f]{64}$/);
  });

  test('accepts only an Apple-signed package', () => {
    assert.equal(packageSignatureOk(APPLE_PKG_SIGNATURE), true);
    assert.equal(packageSignatureOk('Status: no signature'), false);
    assert.equal(
      packageSignatureOk(APPLE_PKG_SIGNATURE.replace('Apple Inc.', 'Someone Else')),
      false,
    );
  });

  test('quotes paths for the shell and for AppleScript', () => {
    assert.equal(shellQuote("/tmp/it's here.pkg"), `'/tmp/it'\\''s here.pkg'`);
    const [flag, script] = adminShellArgs('echo "hi"', 'Why');
    assert.equal(flag, '-e');
    assert.equal(script, 'do shell script "echo \\"hi\\"" with prompt "Why" with administrator privileges');
  });

  test('downloads, checks the signature, installs with admin rights and starts the service', macOnly, async () => {
    const calls: string[] = [];
    let downloaded: { url: string; sha: string } | null = null;
    let installed = false;
    const binary = await installContainerRuntime(CONTAINER_RUNTIME_VERSION, () => {}, {
      installRoot: path.join(tmpRoot, 'container'),
      env: {},
      exists: (file) => installed && file === '/usr/local/bin/container',
      download: async (url, sha, _size, dest) => {
        downloaded = { url, sha };
        fs.writeFileSync(dest, 'pkg');
        return { path: dest, sha256: sha, size: 3 };
      },
      exec: async (bin, args) => {
        calls.push(`${bin} ${args[0]}`);
        if (bin === 'pkgutil') return ok(APPLE_PKG_SIGNATURE);
        if (bin === 'osascript') { installed = true; return ok(); }
        return ok();
      },
    });
    assert.equal(binary, '/usr/local/bin/container');
    assert.deepEqual(downloaded, { url: containerReleaseUrl(CONTAINER_RUNTIME_VERSION), sha: CONTAINER_RUNTIME_SHA256[CONTAINER_RUNTIME_VERSION] });
    assert.deepEqual(calls, ['pkgutil --check-signature', 'osascript -e', '/usr/local/bin/container system']);
  });

  test('never runs the installer for a package with the wrong signature', macOnly, async () => {
    const calls: string[] = [];
    await assert.rejects(
      installContainerRuntime(CONTAINER_RUNTIME_VERSION, () => {}, {
        installRoot: path.join(tmpRoot, 'container-bad'),
        env: {},
        exists: () => false,
        download: async (_url, sha, _size, dest) => { fs.writeFileSync(dest, 'x'); return { path: dest, sha256: sha, size: 1 }; },
        exec: async (bin, args) => { calls.push(`${bin} ${args[0]}`); return ok('Status: no signature'); },
      }),
      /did not sign/,
    );
    assert.deepEqual(calls, ['pkgutil --check-signature']);
  });
});

describe('Docker Desktop install', () => {
  test('picks the download for the platform and chip', () => {
    assert.equal(dockerDesktopUrl('darwin', 'arm64'), 'https://desktop.docker.com/mac/main/arm64/Docker.dmg');
    assert.equal(dockerDesktopUrl('darwin', 'x64'), 'https://desktop.docker.com/mac/main/amd64/Docker.dmg');
    assert.match(dockerDesktopUrl('win32', 'x64') ?? '', /win\/main\/amd64\/Docker%20Desktop%20Installer\.exe$/);
    assert.equal(dockerDesktopUrl('linux', 'x64'), null);
  });

  test('reads the mount point and the signer', () => {
    const plist = '<dict><key>mount-point</key>\n<string>/Volumes/Docker</string></dict>';
    assert.equal(mountPointFromPlist(plist), '/Volumes/Docker');
    assert.equal(mountPointFromPlist('<dict/>'), null);
    assert.equal(dockerSignatureOk('Authority=Developer ID Application: Docker Inc (9BNSXJN65R)\nAuthority=Apple Root CA'), true);
    assert.equal(dockerSignatureOk('Authority=Developer ID Application: Not Docker'), false);
  });

  test('mounts, verifies, copies, unmounts and launches on macOS', macOnly, async () => {
    const calls: string[] = [];
    const target = await installDockerDesktop(() => {}, {
      platform: 'darwin',
      arch: 'arm64',
      workDir: path.join(tmpRoot, 'docker'),
      applicationsDir: '/Applications',
      canWrite: () => true,
      download: async (_url, sha, _size, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'dmg'); return { path: dest, sha256: sha, size: 3 }; },
      exec: async (bin, args) => {
        calls.push(`${bin} ${args[0]}`);
        if (bin === 'hdiutil' && args[0] === 'attach') return ok('<key>mount-point</key><string>/Volumes/Docker</string>');
        if (bin === 'codesign' && args[0] === '-dvv') return { code: 0, stdout: '', stderr: 'Authority=Developer ID Application: Docker Inc (9BNSXJN65R)' };
        return ok();
      },
    });
    assert.equal(target, '/Applications/Docker.app');
    assert.deepEqual(calls, ['hdiutil attach', 'codesign -dvv', 'codesign --verify', 'ditto /Volumes/Docker/Docker.app', 'hdiutil detach', 'open -a']);
  });

  test('refuses an unsigned Docker.app and still unmounts', macOnly, async () => {
    const calls: string[] = [];
    await assert.rejects(
      installDockerDesktop(() => {}, {
        platform: 'darwin',
        arch: 'arm64',
        workDir: path.join(tmpRoot, 'docker-bad'),
        download: async (_url, sha, _size, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'dmg'); return { path: dest, sha256: sha, size: 3 }; },
        exec: async (bin, args) => {
          calls.push(`${bin} ${args[0]}`);
          if (bin === 'hdiutil' && args[0] === 'attach') return ok('<key>mount-point</key><string>/Volumes/Docker</string>');
          return ok('Authority=Developer ID Application: Someone Else');
        },
      }),
      /did not sign/,
    );
    assert.ok(calls.includes('hdiutil detach'));
    assert.ok(!calls.some((c) => c.startsWith('ditto')));
  });
});

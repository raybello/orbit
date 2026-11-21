import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { lanAddress, PhoneAccess } from '../phone-access';

const v4 = (address: string, internal = false): os.NetworkInterfaceInfo => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null });

test('the phone address is a private IPv4 on a physical interface, ahead of VM bridges and tunnels', () => {
  assert.equal(lanAddress({ lo0: [v4('127.0.0.1', true)], bridge100: [v4('192.168.64.1')], utun4: [v4('100.101.1.2')], en0: [v4('192.168.1.23')] }), '192.168.1.23');
  assert.equal(lanAddress({ bridge100: [v4('192.168.64.1')] }), '192.168.64.1');
  assert.equal(lanAddress({ lo0: [v4('127.0.0.1', true)], en0: [v4('169.254.3.4')] }), null);
});

async function loopbackServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.end('from the stack'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { port, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const fetchText = async (url: string) => (await fetch(url)).text();

test('switched on, the phone listener forwards to the loopback stack; off, nothing listens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-phone-'));
  const stack = await loopbackServer();
  const access = new PhoneAccess({ userDataDir: dir, targetPort: () => stack.port, lanHost: () => '127.0.0.1' });
  try {
    assert.deepEqual(access.status(), { phase: 'off' });

    const on = await access.set(true);
    assert.equal(on.phase, 'on');
    const url = (on as { url: string }).url;
    assert.equal(await fetchText(`${url}/api/health`), 'from the stack');

    await access.set(false);
    assert.deepEqual(access.status(), { phase: 'off' });
    await assert.rejects(fetch(`${url}/api/health`), 'closed once switched off');

    const again = new PhoneAccess({ userDataDir: dir, targetPort: () => stack.port, lanHost: () => '127.0.0.1' });
    const reopened = await again.set(true);
    assert.equal((reopened as { url: string }).url, url, 'the same port across launches, so a paired phone keeps working');
    await again.close();
  } finally {
    await access.close();
    await stack.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a running local stack there is nothing to offer, and a saved "on" waits for one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-phone-'));
  fs.writeFileSync(path.join(dir, 'phone-access.json'), JSON.stringify({ enabled: true, port: null }));
  let port: number | null = null;
  const access = new PhoneAccess({ userDataDir: dir, targetPort: () => port, lanHost: () => null });
  try {
    assert.deepEqual(access.status(), { phase: 'unavailable' });
    await access.resume();
    port = 1;
    assert.deepEqual(access.status(), { phase: 'off' }, 'resume did not listen before the stack answered');
    await access.resume();
    assert.deepEqual(access.status(), { phase: 'no-network' });
  } finally {
    await access.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

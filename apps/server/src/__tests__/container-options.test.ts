import assert from 'node:assert/strict';
import test from 'node:test';
import { containerCreateOptions } from '../docker/container.js';

// What a bot container publishes decides two things at once: whether the host can dial the screen,
// and whether a second stack can even start. These tests pin both halves.

const base = { botId: 'bot_x', homePath: '/tmp/home', displayIndex: 1, network: 'bridge' };

test('a host-run server publishes the screen on loopback only', () => {
  const opts = containerCreateOptions(base);
  const bindings = opts.HostConfig?.PortBindings ?? {};
  const values = Object.values(bindings).flat();
  assert.ok(values.length > 0, 'expected port bindings');
  for (const b of values as { HostIp?: string }[]) assert.equal(b.HostIp, '127.0.0.1');
});

test('a containerized server publishes nothing, so stacks cannot fight over host ports', () => {
  const opts = containerCreateOptions({ ...base, publishPorts: false });
  assert.equal(opts.HostConfig?.PortBindings, undefined);
  // The ports stay exposed inside the container — that is how the relay reaches them.
  assert.ok(Object.keys(opts.ExposedPorts ?? {}).length > 0);
});

test('the container still joins the network it was given', () => {
  const opts = containerCreateOptions({ ...base, network: 'orbit_default', publishPorts: false });
  assert.equal(opts.HostConfig?.NetworkMode, 'orbit_default');
});

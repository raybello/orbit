import assert from 'node:assert/strict';
import test from 'node:test';
import { containerCreateOptions, fitsAnother, reservationBytes } from '../docker/container.js';

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

test('a bot container is sized for ten on a 16 GB machine by default', () => {
  const opts = containerCreateOptions(base);
  const host = opts.HostConfig!;
  assert.equal(host.Memory, 900 * 1024 ** 2);
  assert.equal(host.MemorySwap, 900 * 1024 ** 2);
  assert.equal(host.MemoryReservation, 600 * 1024 ** 2);
  assert.equal(host.NanoCpus, 1e9);
  assert.equal(host.ShmSize, 256 * 1024 ** 2);
  assert.ok(opts.Env!.includes('HQ_LEAN_BROWSER=1'));
});

test('the reservation is never above the hard limit, and "0" turns it off', () => {
  assert.equal(reservationBytes('2g', 900 * 1024 ** 2), 900 * 1024 ** 2);
  assert.equal(reservationBytes('0', 900 * 1024 ** 2), 0);
  assert.equal(reservationBytes('', 900 * 1024 ** 2), 0);
  assert.throws(() => reservationBytes('lots', 900 * 1024 ** 2), /COMPUTER_MEMORY_RESERVATION/);
});

test('bots counted at 600 MB: ten fit a 10 GB Docker VM, and an 8 GB one stops at twelve', () => {
  const r = 600 * 1024 ** 2;
  const gb = 1024 ** 3;
  assert.equal(fitsAnother({ hostMemory: 10 * gb, liveBots: 9, reservation: r }), true);
  assert.equal(fitsAnother({ hostMemory: 8 * gb, liveBots: 11, reservation: r }), true);
  assert.equal(fitsAnother({ hostMemory: 8 * gb, liveBots: 12, reservation: r }), false);
  // No reservation or an unknown host size never blocks a start.
  assert.equal(fitsAnother({ hostMemory: 8 * gb, liveBots: 100, reservation: 0 }), true);
  assert.equal(fitsAnother({ hostMemory: 0, liveBots: 100, reservation: r }), true);
});

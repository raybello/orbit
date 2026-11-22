import assert from 'node:assert/strict';
import test from 'node:test';
import { pickComputerRuntime } from '../env.js';
import { appleCreateArgs, cpuArg, ipFromCidr, memoryArg, parseInspect } from '../apple/runtime.js';

const spec = { botId: 'bot_x', homePath: '/Users/me/data/homes/bot_x', displayIndex: 3 };
const opts = { name: 'orbit-bot-bot_x', image: 'orbit/computer:local', cpus: '2', memory: '1536M' };

test('a Mac with Apple container and no Docker picks the Apple runtime in auto mode', () => {
  const mac = { platform: 'darwin', arch: 'arm64' };
  assert.equal(pickComputerRuntime({ ...mac, value: 'auto', dockerSocketPresent: false, appleBinary: '/usr/local/bin/container' }), 'apple');
  assert.equal(pickComputerRuntime({ ...mac, value: 'auto', dockerSocketPresent: true, appleBinary: '/usr/local/bin/container' }), 'docker');
  assert.equal(pickComputerRuntime({ ...mac, value: 'auto', dockerSocketPresent: false, appleBinary: null }), 'docker');
  assert.equal(pickComputerRuntime({ platform: 'linux', arch: 'arm64', value: 'auto', dockerSocketPresent: false, appleBinary: '/x' }), 'docker');
  assert.equal(pickComputerRuntime({ platform: 'darwin', arch: 'x64', value: 'auto', dockerSocketPresent: false, appleBinary: '/x' }), 'docker');
});

test('COMPUTER_RUNTIME forces a runtime whatever is installed', () => {
  assert.equal(pickComputerRuntime({ value: 'apple', platform: 'linux', appleBinary: null }), 'apple');
  assert.equal(pickComputerRuntime({ value: 'docker', platform: 'darwin', arch: 'arm64', dockerSocketPresent: false, appleBinary: '/x' }), 'docker');
});

test('the create command sizes the VM for Chromium and mounts only the bot home', () => {
  const args = appleCreateArgs(spec, opts);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'create');
  assert.equal(at('--name'), 'orbit-bot-bot_x');
  assert.equal(at('--memory'), '1536M');
  assert.equal(at('--cpus'), '2');
  assert.equal(at('--shm-size'), '256M');
  assert.equal(at('--cap-drop'), 'ALL');
  assert.equal(at('--volume'), '/Users/me/data/homes/bot_x:/home/bot');
  assert.equal(args.filter((a) => a === '--volume').length, 1);
  assert.equal(args.at(-1), 'orbit/computer:local');
  assert.ok(!args.includes('--publish'), 'nothing is published: the VM has its own address');
});

test('the VM browser is told it has no GPU and runs lean', () => {
  const env = appleCreateArgs(spec, opts).filter((_, i, a) => a[i - 1] === '--env');
  assert.ok(env.includes('HQ_VM_BROWSER=1'));
  assert.ok(env.includes('HQ_LEAN_BROWSER=1'));
  assert.ok(env.includes('DISPLAY=:3'));
});

test('bots are labelled so they can be found again', () => {
  const args = appleCreateArgs(spec, opts);
  const labels = args.filter((_, i, a) => a[i - 1] === '--label');
  assert.deepEqual(labels, ['orbit.managed=true', 'orbit.botId=bot_x']);
});

test('sizes are whole MiB and a VM gets two vCPUs at least', () => {
  assert.equal(memoryArg(1536 * 1024 ** 2), '1536M');
  assert.equal(memoryArg(10), '256M');
  assert.equal(cpuArg(1), '2');
  assert.equal(cpuArg(0.5), '2');
  assert.equal(cpuArg(3), '3');
});

test('the VM address is read from inspect and stripped of its prefix length', () => {
  assert.equal(ipFromCidr('192.168.64.3/24'), '192.168.64.3');
  assert.equal(ipFromCidr(undefined), null);
  assert.equal(ipFromCidr('fd65::1/64'), null);
  const json = JSON.stringify([{
    configuration: { id: 'orbit-bot-bot_x', labels: { 'orbit.managed': 'true', 'orbit.botId': 'bot_x' } },
    id: 'orbit-bot-bot_x',
    status: { state: 'running', networks: [{ ipv4Address: '192.168.64.7/24' }] },
  }]);
  assert.deepEqual(parseInspect(json), [{ id: 'orbit-bot-bot_x', state: 'running', ip: '192.168.64.7', labels: { 'orbit.managed': 'true', 'orbit.botId': 'bot_x' } }]);
  assert.deepEqual(parseInspect('not json'), []);
  assert.deepEqual(parseInspect('[]'), []);
});

test('a stopped VM has no address to dial', () => {
  const [c] = parseInspect(JSON.stringify([{ id: 'a', status: { state: 'stopped', networks: [] } }]));
  assert.equal(c?.state, 'stopped');
  assert.equal(c?.ip, null);
});

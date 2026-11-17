import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOST_AUDIOCPP_URL,
  SIDECAR_URL,
  applyGpuVoice,
  detectNvidiaGpu,
  gpuProfileArgs,
  gpuVoiceEnabled,
  gpuVoiceSupport,
} from '../gpu-voice';
import { envValue } from '../env-file';

const ENV = 'SESSION_SECRET=abc\nORBIT_GPU_VOICE=0\nAUDIOCPP_URL=\n';

test('installing GPU voice turns on the compose profile and points the api at the sidecar', () => {
  const on = applyGpuVoice(ENV, true, 'win32');
  assert.equal(gpuVoiceEnabled(on, 'win32'), true);
  assert.deepEqual(gpuProfileArgs(on, 'win32'), ['--profile', 'gpu']);
  assert.equal(envValue(on, 'AUDIOCPP_URL'), SIDECAR_URL);
  assert.equal(envValue(on, 'SESSION_SECRET'), 'abc', 'the rest of the .env is kept');

  const off = applyGpuVoice(on, false, 'win32');
  assert.equal(gpuVoiceEnabled(off, 'win32'), false);
  assert.deepEqual(gpuProfileArgs(off, 'win32'), []);
  assert.equal(envValue(off, 'AUDIOCPP_URL'), HOST_AUDIOCPP_URL, 'back to a native server on the host');
});

test('macOS never runs the sidecar and turns GPU voice off for the server', () => {
  const mac = applyGpuVoice(ENV, true, 'darwin');
  assert.equal(gpuVoiceEnabled(mac, 'darwin'), false);
  assert.deepEqual(gpuProfileArgs('ORBIT_GPU_VOICE=1\n', 'darwin'), [], 'even a hand-edited .env cannot start it');
  assert.equal(envValue(mac, 'AUDIOCPP_URL'), 'off');
  assert.deepEqual(gpuVoiceSupport('darwin', 'NVIDIA X', 'docker'), { supported: false, reason: 'macos' });
});

test('a GPU server the person set up elsewhere survives turning the sidecar off', () => {
  const custom = applyGpuVoice('AUDIOCPP_URL=http://10.0.0.5:8080\n', false, 'linux');
  assert.equal(envValue(custom, 'AUDIOCPP_URL'), 'http://10.0.0.5:8080');
});

test('support needs the Docker stack and an NVIDIA GPU', () => {
  assert.deepEqual(gpuVoiceSupport('win32', null, 'docker'), { supported: false, reason: 'no-nvidia' });
  assert.deepEqual(gpuVoiceSupport('linux', 'RTX', 'native'), { supported: false, reason: 'not-docker-stack' });
  assert.deepEqual(gpuVoiceSupport('win32', 'RTX', 'docker'), { supported: true, gpu: 'RTX' });
});

test('detectNvidiaGpu reads nvidia-smi, and a missing driver is null', async () => {
  assert.equal(
    await detectNvidiaGpu(async () => ({ code: 0, stdout: 'NVIDIA GeForce RTX 5070 Ti, 16303\r\n' })),
    'NVIDIA GeForce RTX 5070 Ti · 16 GB',
  );
  assert.equal(await detectNvidiaGpu(async () => ({ code: 1, stdout: '' })), null);
  assert.equal(await detectNvidiaGpu(async () => { throw new Error('ENOENT'); }), null);
});

/**
 * The degraded path: this server can run without the sherpa-onnx native addon.
 *
 * The macOS native stack runs a *downloaded* server bundle, and whether `sherpa-onnx-node` and its
 * darwin-arm64 binary made it into that tarball is decided at release time — `scripts/verify-server-bundle.mjs`
 * is the gate, and this test is the other half of the contract: when the gate fails, the server must
 * stay up, say so honestly, and not touch the model cache. Never a crash on import, never a 500, and
 * never a 263 MB download for a runtime that cannot use it.
 *
 * The addon here comes from a TEST-ONLY seam (`__setAddonLoaderForTests`) so this file proves the
 * same thing on a machine that has the prebuilt binary and in CI that does not. The seam is restored
 * in a hook; the second test is the control that proves it.
 *
 * Run with:  pnpm --filter @orbit/server test
 */
import './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { cleanupTmpEnv, tmpRoot } from './helpers/tmp-env.js';

// An empty model cache: nothing exists here, so anything a downloader wrote would be visible.
// VOICE_MODELS_DIR is deliberately *not* the real cache — a regression that starts downloading must
// be caught in a temp dir, not papered over by 263 MB that are already on disk.
const MODELS_DIR = path.join(tmpRoot, 'voice-models-empty');
fs.mkdirSync(MODELS_DIR, { recursive: true });
process.env.VOICE_MODELS_DIR = MODELS_DIR;
// Leave auto-download at its default on purpose: the point is that the *degraded path* prevents the
// download, not that the environment disabled it. The second test turns it off once the addon is back.
delete process.env.VOICE_AUTO_DOWNLOAD;

const runtime = await import('../voice-runtime.js');
const { localVoiceApi } = await import('../voice-local.js');
const { db } = await import('../db.js');

after(() => cleanupTmpEnv());

const TOKEN = 'voice-degraded-test-token';
const USER = 'usr_voice_degraded';
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'voice-degraded@test.local', 'Voice Degraded', Date.now());
db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(TOKEN, USER, Date.now(), Date.now() + 3600_000);

/** Bearer instead of a cookie: the same session, and the header is the API's documented client path. */
const AUTH = { authorization: `Bearer ${TOKEN}` };
const route = (pathname: string, init: RequestInit = {}) =>
  localVoiceApi.request(pathname, { ...init, headers: { ...AUTH, ...((init.headers as Record<string, string>) ?? {}) } });

/** Every file under the model cache, so "nothing was downloaded" is a fact and not a hope. */
function modelCacheFiles(dir = MODELS_DIR, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out.push(path.relative(MODELS_DIR, full));
    if (entry.isDirectory()) modelCacheFiles(full, out);
  }
  return out.sort();
}

/** Whether the *real* addon loads on this machine, so the control test can be honest about it. */
const realAddonAvailable = (() => {
  runtime.__setAddonLoaderForTests(null);
  return runtime.runtimeInfo().addon;
})();

test('a missing addon degrades to unsupported-runtime instead of crashing', async (t) => {
  // Behave exactly like a server bundle that shipped without node_modules/sherpa-onnx-node.
  runtime.__setAddonLoaderForTests(() => {
    throw new Error("Cannot find module 'sherpa-onnx-node' (simulated missing addon: degraded-path test)");
  });
  t.after(() => runtime.__setAddonLoaderForTests(null));

  // 1. runtimeInfo() is the single source of truth the routes consult.
  const info = runtime.runtimeInfo();
  assert.equal(info.addon, false, `addon must report false when the probe throws, got ${JSON.stringify(info)}`);
  assert.equal(info.provider, 'cpu', `provider stays cpu: ${JSON.stringify(info)}`);
  assert.deepEqual(
    [info.platform, info.arch],
    [process.platform, process.arch],
    `runtime must still report the real platform: ${JSON.stringify(info)}`,
  );
  assert.match(
    String(runtime.runtimeError()),
    /simulated missing addon/,
    `runtimeError() must carry the loader's reason, got ${JSON.stringify(runtime.runtimeError())}`,
  );

  // 2. /status answers 200 with the honest body, and the reason the client keys off.
  const status = await route('/status');
  assert.equal(status.status, 200, `a degraded /status is a successful read, not an error; got ${status.status}`);
  const body = (await status.json()) as any;
  assert.equal(body.available, false, `available must be false: ${JSON.stringify(body)}`);
  assert.equal(body.reason, 'unsupported-runtime', `reason must be unsupported-runtime, got ${body.reason}`);
  assert.deepEqual(
    body.runtime,
    { platform: process.platform, arch: process.arch, provider: 'cpu', addon: false },
    `runtime block: ${JSON.stringify(body.runtime)}`,
  );
  assert.equal(body.download.active, false, `no download may be active: ${JSON.stringify(body.download)}`);

  // 3. And no download was started: give a fire-and-forget downloader time to misfire, then look.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    modelCacheFiles(),
    [],
    `the degraded path must not download any model files; found ${modelCacheFiles().join(', ')} in ${MODELS_DIR}`,
  );
  const again = (await (await route('/status')).json()) as any;
  assert.equal(again.download.active, false, `still no download after a second /status: ${JSON.stringify(again.download)}`);
  assert.ok(
    Object.values(again.models ?? {}).every((s) => s !== 'downloading'),
    `no model kind may be downloading: ${JSON.stringify(again.models)}`,
  );

  // 4. /stt answers 503 with the same reason, before it touches the body or an engine.
  const stt = await route('/stt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Rate': '16000' },
    body: new Uint8Array(640), // 20 ms of silence at 16 kHz: a legal request shape
  });
  assert.equal(stt.status, 503, `/stt must be 503 without the addon, got ${stt.status}`);
  assert.deepEqual(await stt.json(), { available: false, reason: 'unsupported-runtime' }, '/stt body');

  // 5. /preview answers 503 too — the UI shows "On-device unavailable", it does not get a 502.
  const preview = await route('/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Hello from the degraded path.' }),
  });
  assert.equal(preview.status, 503, `/preview must be 503 without the addon, got ${preview.status}`);
  assert.deepEqual(await preview.json(), { available: false, reason: 'unsupported-runtime' }, '/preview body');

  // 6. Asking for an engine fails *cleanly*: a rejected promise, not an uncaught throw from
  //    require(), which is what would take the process down at boot on a bundle without the addon.
  await assert.rejects(
    () => runtime.getRecognizer(),
    /local voice runtime unavailable: .*simulated missing addon/,
    'getRecognizer() must reject with the addon reason, not throw synchronously or crash',
  );
});

test('the seam is removed: the next probe sees the real addon again', async () => {
  // The degraded test restored the loader in its after() hook; this is the control that proves the
  // restore actually happened instead of the module being stuck in "missing" for the whole process.
  // A real addon would also warm /status's auto-download, which is not this file's business.
  process.env.VOICE_AUTO_DOWNLOAD = '0';

  const info = runtime.runtimeInfo();
  assert.equal(
    info.addon,
    realAddonAvailable,
    `after the restore addon must match the real machine (${realAddonAvailable}), got ${JSON.stringify(info)}`,
  );

  const body = (await (await route('/status')).json()) as any;
  assert.equal(body.runtime.addon, realAddonAvailable, `status.runtime.addon: ${JSON.stringify(body.runtime)}`);
  assert.equal(
    body.reason,
    realAddonAvailable ? 'models-missing' : 'unsupported-runtime',
    `with the addon back and an empty model dir the reason is models-missing; got ${body.reason} (${JSON.stringify(body.models)})`,
  );
});

/**
 * End-to-end smoke test for the Docker computer provider. Not part of the build: run it by hand
 * against a scratch database and a running Docker daemon.
 *
 *   DB_PATH=/tmp/orbit-smoke.db COMPUTER_HOME_DIR=/tmp/orbit-smoke \
 *   DOCKER_SOCKET=unix:///... npx tsx scripts/smoke-docker.ts
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import { db, now } from '../src/db.js';
import '../src/db-config.js';
import { dockerProvider } from '../src/docker-provider.js';
import { getScreen, getComputer } from '../src/computer-store.js';
import { vncAuthResponse } from '../src/lib/des.js';

const BOT = 'bot_smoke';

function seed() {
  db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('usr_smoke', 'smoke@example.com', 'Smoke', now());
  db.prepare(
    `INSERT OR REPLACE INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,engine,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(BOT, 'usr_smoke', 'Smoke Bot', 'Tester', '', '', 'blob', 'violet', 'personal', 0, 'managed', now(), now());
}

/** RFB handshake straight out of the relay: proves the VNC password and server both work. */
async function vncHandshake(port: number, password: string): Promise<string> {
  let last: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      return await vncHandshakeOnce(port, password);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw last;
}

function vncHandshakeOnce(port: number, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let buf = Buffer.alloc(0);
    let stage = 0;
    const timeout = setTimeout(() => reject(new Error('VNC handshake timed out')), 15_000);
    const pump = () => {
      if (stage === 0 && buf.length >= 12) {
        const version = buf.subarray(0, 12).toString();
        buf = buf.subarray(12);
        sock.write('RFB 003.008\n');
        stage = 1;
        if (!version.startsWith('RFB 003')) reject(new Error(`odd version ${version}`));
      }
      if (stage === 1 && buf.length >= 1) {
        const n = buf[0];
        if (n === 0) {
          const len = buf.readUInt32BE(1);
          return reject(new Error(`refused: ${buf.subarray(5, 5 + len).toString()}`));
        }
        if (buf.length < 1 + n) return;
        const types = [...buf.subarray(1, 1 + n)];
        buf = buf.subarray(1 + n);
        const choice = types.includes(2) ? 2 : types.includes(1) ? 1 : -1;
        if (choice < 0) return reject(new Error(`no usable security types: ${types}`));
        sock.write(Buffer.from([choice]));
        stage = choice === 2 ? 2 : 4;
      }
      if (stage === 2 && buf.length >= 16) {
        const challenge = buf.subarray(0, 16);
        buf = buf.subarray(16);
        sock.write(vncAuthResponse(password, challenge));
        stage = 3;
      }
      if (stage === 3 && buf.length >= 4) {
        const result = buf.readUInt32BE(0);
        if (result !== 0) return reject(new Error('VNC auth failed'));
        buf = buf.subarray(4);
        stage = 4;
      }
      if (stage === 4) {
        sock.write(Buffer.from([1]));
        stage = 5;
      }
      if (stage === 5 && buf.length >= 24) {
        const w = buf.readUInt16BE(0);
        const h = buf.readUInt16BE(2);
        const nameLen = buf.readUInt32BE(20);
        if (buf.length < 24 + nameLen) return;
        const name = buf.subarray(24, 24 + nameLen).toString();
        clearTimeout(timeout);
        sock.destroy();
        resolve(`${w}x${h} "${name}"`);
      }
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try { pump(); } catch (e) { clearTimeout(timeout); reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

const step = (name: string) => console.log(`\n=== ${name} ===`);

async function main() {
  seed();
  step('ensureComputer');
  const ref = await dockerProvider.ensureComputer(BOT);
  console.log(ref, getComputer(BOT));

  step('screenFor');
  const screen = await dockerProvider.screenFor('usr_smoke', BOT);
  const row = getScreen(BOT)!;
  console.log(screen, row);

  step('bash');
  const disp = await dockerProvider.bash(BOT, 'xdpyinfo | sed -n 1,4p; echo HOME=$HOME; command -v chromium', 30);
  console.log(disp.output, disp.exit_code);

  step('readyScreen (dress + Chrome)');
  const t0 = Date.now();
  await dockerProvider.readyScreen('usr_smoke', BOT);
  console.log(`dressed in ${Math.round((Date.now() - t0) / 1000)}s`);

  step('CDP');
  const cdp = await dockerProvider.cdpUrl(BOT, row.screen_id);
  const version = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  console.log(cdp, JSON.stringify(version).slice(0, 200));

  step('VNC handshake');
  const password = await dockerProvider.vncPassword(BOT, row.screen_id);
  console.log('server init:', await vncHandshake(row.vnc_port!, password));

  step('screenshot');
  const shot = await dockerProvider.screenshot(BOT, row.screen_id);
  if (shot) {
    const file = '/tmp/orbit-smoke-screen.png';
    await fs.writeFile(file, shot.data);
    console.log(`saved ${file} (${shot.data.length} bytes)`);
  } else console.log('no screenshot');

  step('suspend');
  await dockerProvider.suspend(BOT);
  console.log(getComputer(BOT));

  step('checkpoint');
  const { homeDirFor } = await import('../src/docker/workspace.js');
  const checkpoint = `${process.env.COMPUTER_HOME_DIR}/workspaces/${BOT}.tar.gz`;
  const checkpointSize = (await fs.stat(checkpoint)).size;
  const homeEntries = await fs.readdir(homeDirFor(BOT));
  console.log(`checkpoint ${checkpoint} (${checkpointSize} bytes), home has ${homeEntries.length} entries`);
  if (checkpointSize < 1024 || homeEntries.length === 0) throw new Error('the home folder or its checkpoint is empty');

  step('resume');
  await dockerProvider.ensureComputer(BOT);
  await dockerProvider.screenFor('usr_smoke', BOT);
  console.log('screen alive:', await vncHandshake(row.vnc_port!, password));
  await dockerProvider.readyScreen('usr_smoke', BOT);
  const version2 = await fetch(`${await dockerProvider.cdpUrl(BOT, row.screen_id)}/json/version`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  console.log('browser after resume:', JSON.stringify(version2).slice(0, 120));
  if ('error' in version2) throw new Error('the browser did not come back after resume');

  step('destroy');
  if (process.env.KEEP === '1') {
    console.log('KEEP=1: leaving the container running');
    return;
  }
  await dockerProvider.destroy(BOT, { wipeWorkspace: true });
  console.log(getComputer(BOT), getScreen(BOT));
}

main().then(
  () => { console.log('\nSMOKE OK'); process.exit(0); },
  (e) => { console.error('\nSMOKE FAILED:', e); process.exit(1); },
);

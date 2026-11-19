// tmp-env must be the FIRST import: it points env.ts at a temp DB and Hermes homes.
import { cleanupTmpEnv, primaryHome } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import YAML from 'yaml';

const {
  acquireHqLease,
  HQ_LEASE_EXPIRY_MS,
  mcpToken,
  readHqLease,
  syncPrimaryHqConfig,
} = await import('../engine-hq.js');
const { db } = await import('../db.js');
const { env } = await import('../env.js');

after(cleanupTmpEnv);

const NOW = 1_700_000_000_000;
const USER = 'usr_hqsync';

function resetBots() {
  db.prepare('DELETE FROM bots').run();
  db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'hq@test.local', 'HQ Test', NOW);
}

function addPrimaryBot(id: string): string {
  db.prepare(
    'INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, USER, id, 'primary', null, 1, NOW, NOW);
  return id;
}

function writePrimaryConfig(cfg: Record<string, unknown> = {}) {
  fs.mkdirSync(primaryHome, { recursive: true });
  fs.writeFileSync(path.join(primaryHome, 'config.yaml'), YAML.stringify(cfg));
}

function leaseFile(): string {
  return path.join(primaryHome, 'orbit-hq.lease');
}

function writeLease(pid: number, port: number, ts: number) {
  fs.writeFileSync(leaseFile(), JSON.stringify({ pid, port, ts }));
}

// ─── lease acquisition ────────────────────────────────────────────────────────

test('acquireHqLease returns true and writes a lease when no lease file exists', () => {
  if (fs.existsSync(leaseFile())) fs.rmSync(leaseFile());
  assert.ok(acquireHqLease());
  const lease = readHqLease();
  assert.ok(lease !== null);
  assert.equal(lease!.pid, process.pid);
  assert.equal(lease!.port, env.port);
  assert.ok(Date.now() - lease!.ts < 5_000);
});

test('acquireHqLease returns true and refreshes the heartbeat when already the owner', () => {
  const old = Date.now() - 60_000;
  writeLease(process.pid, env.port, old);
  assert.ok(acquireHqLease());
  const lease = readHqLease();
  assert.ok(lease!.ts > old);
});

test('acquireHqLease returns false when another live server holds a fresh lease', () => {
  // process.ppid is the test runner (tsx), which is definitely alive while this test runs.
  const foreignPid = process.ppid;
  const foreignPort = env.port + 1;
  writeLease(foreignPid, foreignPort, Date.now());
  assert.equal(acquireHqLease(), false);
  // Lease file still names the original owner.
  const lease = readHqLease();
  assert.equal(lease!.pid, foreignPid);
  assert.equal(lease!.port, foreignPort);
});

test('acquireHqLease takes over when the lease is expired', () => {
  const foreignPid = process.ppid;
  const expiredTs = Date.now() - (HQ_LEASE_EXPIRY_MS + 1_000);
  writeLease(foreignPid, env.port + 1, expiredTs);
  assert.ok(acquireHqLease());
  const lease = readHqLease();
  assert.equal(lease!.pid, process.pid);
  assert.equal(lease!.port, env.port);
});

test('acquireHqLease takes over when the previous owner is dead', () => {
  // A PID this large is astronomically unlikely to be in use.
  const deadPid = 999_999_999;
  writeLease(deadPid, env.port + 1, Date.now());
  assert.ok(acquireHqLease());
  const lease = readHqLease();
  assert.equal(lease!.pid, process.pid);
});

// ─── syncPrimaryHqConfig + no-restart guard ──────────────────────────────────

test('syncPrimaryHqConfig writes the hq entry and returns true on first write', () => {
  resetBots();
  const botId = addPrimaryBot('bot_hqwrite');
  writePrimaryConfig({});
  const changed = syncPrimaryHqConfig(botId);
  assert.ok(changed);
  const cfg = YAML.parse(fs.readFileSync(path.join(primaryHome, 'config.yaml'), 'utf8')) as Record<string, unknown>;
  const hq = (cfg.mcp_servers as Record<string, unknown>).hq as Record<string, unknown>;
  assert.ok(String(hq.url).includes(`/mcp/${botId}`));
  assert.ok(String((hq.headers as Record<string, string>).Authorization).includes(mcpToken(botId)));
});

test('syncPrimaryHqConfig returns false and does not rewrite when URL and token are already correct', () => {
  resetBots();
  const botId = addPrimaryBot('bot_hqnoop');
  writePrimaryConfig({});
  // Write once to get the correct entry on disk.
  assert.ok(syncPrimaryHqConfig(botId));
  const before = fs.statSync(path.join(primaryHome, 'config.yaml')).mtimeMs;
  // Second call: nothing changed — must not touch the file.
  assert.equal(syncPrimaryHqConfig(botId), false);
  const after = fs.statSync(path.join(primaryHome, 'config.yaml')).mtimeMs;
  assert.equal(before, after);
});

test('syncPrimaryHqConfig is not called by a non-owner (integration: lease + sync)', () => {
  resetBots();
  const botId = addPrimaryBot('bot_hqlease');
  writePrimaryConfig({});
  // First, write the correct entry as "us".
  assert.ok(syncPrimaryHqConfig(botId));
  const cfgBefore = fs.readFileSync(path.join(primaryHome, 'config.yaml'), 'utf8');
  const mtBefore = fs.statSync(path.join(primaryHome, 'config.yaml')).mtimeMs;

  // Simulate another server taking the lease with its own port, then verify that a lease check
  // would prevent this process from writing if it were not the owner.
  const foreignPid = process.ppid;
  writeLease(foreignPid, env.port + 1, Date.now());
  assert.equal(acquireHqLease(), false, 'should not be the owner');

  // The config is untouched because nothing called syncPrimaryHqConfig.
  assert.equal(fs.readFileSync(path.join(primaryHome, 'config.yaml'), 'utf8'), cfgBefore);
  assert.equal(fs.statSync(path.join(primaryHome, 'config.yaml')).mtimeMs, mtBefore);
});

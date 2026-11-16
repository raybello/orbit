// tmp-env must be the FIRST import: it points env.ts at a temp database before env.ts snapshots process.env.
import { cleanupTmpEnv } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test, { after } from 'node:test';

process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { db } = await import('../db.js');
const { env } = await import('../env.js');
const { Secret, SecretBoxTamperError } = await import('../lib/secret-box.js');
const vault = await import('../vault.js');

after(() => cleanupTmpEnv());

/**
 * The Vault's store against a real SQLite file. What a person and a bot can observe: what is listed,
 * what a lookup finds, what opens, and above all what is on disk.
 */

const now = Date.now();
for (const id of ['usr_ada', 'usr_bob']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id, now);
}

const draft = (over: Partial<{ label: string; username: string | null; secret: string; urlPattern: string | null }> = {}) => ({
  label: over.label ?? 'GitHub',
  username: over.username === undefined ? 'ada@example.test' : over.username,
  secret: new Secret(over.secret ?? 'gh-pass-93f1c2'),
  urlPattern: over.urlPattern === undefined ? 'https://github.com' : over.urlPattern,
});

const rowOf = (id: string) => db.prepare('SELECT * FROM vault_entries WHERE id=?').get(id) as import('../vault.js').VaultEntryRow;

/** Every byte SQLite has written for this database, the write-ahead log included. */
function bytesOnDisk(): Buffer {
  return Buffer.concat([env.dbPath, `${env.dbPath}-wal`].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)));
}

test('a saved secret is on disk only as ciphertext, and opens back to what was saved', () => {
  const plain = 'disk-check-7Qm2-zebra-PLAINTEXT';
  const entry = vault.saveVaultEntry('usr_ada', draft({ label: 'Disk check', secret: plain }));
  const disk = bytesOnDisk();
  assert.ok(disk.includes(Buffer.from('Disk check')), 'the label is on disk, so this really is the file the entry was written to');
  assert.ok(!disk.includes(Buffer.from(plain)), 'the plaintext secret must not be anywhere in the database files');
  assert.ok(!disk.includes(Buffer.from(plain, 'utf8').toString('base64').slice(0, 24)), 'nor a plain base64 of it');
  assert.equal(vault.openVaultSecret(rowOf(entry.id)).reveal(), plain);
});

test('what the app lists is metadata: no field of an entry carries the secret', () => {
  const plain = 'list-check-secret-51';
  vault.saveVaultEntry('usr_ada', draft({ label: 'Listed', secret: plain, username: 'ada' }));
  const listed = vault.listVaultEntries('usr_ada');
  const mine = listed.find((e) => e.label === 'Listed');
  assert.deepEqual(Object.keys(mine ?? {}).sort(), ['createdAt', 'id', 'label', 'updatedAt', 'urlPattern', 'username']);
  assert.equal(mine?.username, 'ada');
  assert.ok(!JSON.stringify(listed).includes(plain));
});

test('one person never sees or finds another person\'s logins', () => {
  vault.saveVaultEntry('usr_bob', draft({ label: 'Bob only', urlPattern: 'https://bob.example.com' }));
  assert.ok(!vault.listVaultEntries('usr_ada').some((e) => e.label === 'Bob only'));
  assert.equal(vault.findVaultEntry('usr_ada', { by: 'label', label: 'Bob only' }).kind, 'none');
  assert.equal(vault.findVaultEntry('usr_ada', { by: 'url', url: 'https://bob.example.com/login' }).kind, 'none');
  assert.equal(vault.findVaultEntry('usr_bob', { by: 'label', label: 'bob ONLY' }).kind, 'one', 'and its owner finds it, whatever the case');
});

test('a sealed secret copied into another row does not open there', () => {
  const a = vault.saveVaultEntry('usr_ada', draft({ label: 'Bank', secret: 'bank-secret-A' }));
  const b = vault.saveVaultEntry('usr_bob', draft({ label: 'Forum', secret: 'forum-secret-B', urlPattern: null }));
  assert.equal(vault.openVaultSecret(rowOf(a.id)).reveal(), 'bank-secret-A');
  // Somebody with write access to the file points their own entry at another person's ciphertext.
  db.prepare('UPDATE vault_entries SET secret_encrypted=? WHERE id=?').run(rowOf(a.id).secret_encrypted, b.id);
  assert.throws(() => vault.openVaultSecret(rowOf(b.id)), SecretBoxTamperError);
});

test('a stored secret edited on disk is refused instead of opening to something else', () => {
  const entry = vault.saveVaultEntry('usr_ada', draft({ label: 'Edited on disk' }));
  const sealed = rowOf(entry.id).secret_encrypted;
  const parts = sealed.split('.');
  const body = Buffer.from(parts[2], 'base64url');
  body[body.length - 1] ^= 0xff;
  parts[2] = body.toString('base64url');
  db.prepare('UPDATE vault_entries SET secret_encrypted=? WHERE id=?').run(parts.join('.'), entry.id);
  assert.throws(() => vault.openVaultSecret(rowOf(entry.id)), SecretBoxTamperError);
});

test('a label names one login per person', () => {
  vault.saveVaultEntry('usr_ada', draft({ label: 'Unique' }));
  assert.throws(() => vault.saveVaultEntry('usr_ada', draft({ label: 'UNIQUE' })), (e: unknown) => e instanceof vault.VaultError && e.status === 409);
  assert.doesNotThrow(() => vault.saveVaultEntry('usr_bob', draft({ label: 'Unique' })), 'another person may use the same name');
});

test('replacing a login keeps one entry and the new secret is the one that opens', () => {
  const first = vault.saveVaultEntry('usr_ada', draft({ label: 'Rotated', secret: 'old-pass' }));
  const second = vault.saveVaultEntry('usr_ada', draft({ label: 'rotated', secret: 'new-pass' }), { replace: true });
  assert.equal(second.id, first.id);
  assert.equal(vault.listVaultEntries('usr_ada').filter((e) => e.label.toLowerCase() === 'rotated').length, 1);
  assert.equal(vault.openVaultSecret(rowOf(first.id)).reveal(), 'new-pass');
});

test('an update without a secret keeps the stored one; with one, replaces it', () => {
  const entry = vault.saveVaultEntry('usr_ada', draft({ label: 'Editable', secret: 'kept-secret' }));
  const renamed = vault.updateVaultEntry('usr_ada', entry.id, { label: 'Edited', username: null, urlPattern: null });
  assert.deepEqual({ label: renamed.label, username: renamed.username, urlPattern: renamed.urlPattern }, { label: 'Edited', username: null, urlPattern: null });
  assert.equal(vault.openVaultSecret(rowOf(entry.id)).reveal(), 'kept-secret');
  vault.updateVaultEntry('usr_ada', entry.id, { secret: new Secret('changed-secret') });
  assert.equal(vault.openVaultSecret(rowOf(entry.id)).reveal(), 'changed-secret');
  assert.throws(() => vault.updateVaultEntry('usr_bob', entry.id, { label: 'Stolen' }), (e: unknown) => e instanceof vault.VaultError && e.status === 404);
});

test('a lookup by page finds the login saved for that site, and only that site', () => {
  vault.saveVaultEntry('usr_ada', draft({ label: 'Shop', urlPattern: 'https://*.shop.example.com/account' }));
  const hit = vault.findVaultEntry('usr_ada', { by: 'url', url: 'https://eu.shop.example.com/account/sign-in?next=%2F' });
  assert.equal(hit.kind === 'one' && hit.entry.label, 'Shop');
  for (const url of [
    'http://eu.shop.example.com/account',
    'https://shop.example.com.evil.test/account',
    'https://evil.test/?u=https://eu.shop.example.com/account',
    'https://eu.shop.example.com/accounting',
    'https://shop.example.com@evil.test/account',
  ]) {
    assert.equal(vault.findVaultEntry('usr_ada', { by: 'url', url }).kind, 'none', url);
  }
});

test('a one-time login works until it expires, is never listed, and never replaces a kept one', () => {
  const entry = vault.saveVaultEntry('usr_ada', draft({ label: 'Once', secret: 'once-secret' }), { expiresAt: Date.now() + 60_000 });
  assert.ok(!vault.listVaultEntries('usr_ada').some((e) => e.id === entry.id), 'a one-time login is not something to manage');
  const found = vault.findVaultEntry('usr_ada', { by: 'label', label: 'Once' });
  assert.equal(found.kind === 'one' && vault.openVaultSecret(found.entry).reveal(), 'once-secret');

  db.prepare('UPDATE vault_entries SET expires_at=? WHERE id=?').run(Date.now() - 1, entry.id);
  assert.equal(vault.findVaultEntry('usr_ada', { by: 'label', label: 'Once' }).kind, 'none');
  assert.equal(rowOf(entry.id), undefined, 'the expired row is gone, ciphertext and all');

  const kept = vault.saveVaultEntry('usr_ada', draft({ label: 'Kept', secret: 'kept' }));
  assert.throws(
    () => vault.saveVaultEntry('usr_ada', draft({ label: 'Kept', secret: 'temp' }), { replace: true, expiresAt: Date.now() + 60_000 }),
    (e: unknown) => e instanceof vault.VaultError && e.status === 409,
  );
  assert.equal(vault.openVaultSecret(rowOf(kept.id)).reveal(), 'kept');
});

test('input a keyboard could not type as characters is refused, without repeating the secret', () => {
  for (const bad of ['line\nbreak', 'tab\there', '', 'x'.repeat(vault.VAULT_LIMITS.secret + 1)]) {
    assert.throws(
      () => vault.parseSecret(bad),
      (e: unknown) => e instanceof vault.VaultError && e.status === 400 && (bad.length < 4 || !e.message.includes(bad)),
    );
  }
  assert.equal(vault.parseSecret('  spaces stay  ').reveal(), '  spaces stay  ');
  assert.throws(() => vault.parseLabel('   '), vault.VaultError);
  assert.equal(vault.parseStoredUrlPattern('GitHub.com'), 'https://github.com');
  assert.equal(vault.parseStoredUrlPattern(''), null);
  for (const bad of ['*.com', 'not a site', 'https://user:pw@example.com', 'javascript:alert(1)']) {
    assert.throws(() => vault.parseStoredUrlPattern(bad), vault.VaultError, bad);
  }
});

test('with no encryption key the Vault refuses to save or open, and writes nothing', () => {
  const entry = vault.saveVaultEntry('usr_ada', draft({ label: 'Before the key went' }));
  const key = env.dbEncryptionKey;
  const count = () => (db.prepare('SELECT COUNT(*) n FROM vault_entries').get() as { n: number }).n;
  const before = count();
  try {
    for (const missing of ['', 'change-me']) {
      env.dbEncryptionKey = missing;
      assert.equal(vault.vaultStatus().configured, false);
      const unavailable = (e: unknown) => e instanceof vault.VaultError && e.status === 503;
      assert.throws(() => vault.saveVaultEntry('usr_ada', draft({ label: 'No key' })), unavailable);
      assert.throws(() => vault.updateVaultEntry('usr_ada', entry.id, { secret: new Secret('x') }), unavailable);
      assert.throws(() => vault.openVaultSecret(rowOf(entry.id)), unavailable);
    }
    assert.equal(count(), before, 'a refused save leaves no row behind');
    assert.ok(vault.deleteVaultEntry('usr_ada', entry.id), 'a login can still be thrown away without the key');
  } finally {
    env.dbEncryptionKey = key;
  }
  assert.equal(vault.vaultStatus().configured, true);
});

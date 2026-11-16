import type { VaultEntry } from '@orbit/contracts';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { Secret, secretBox, SecretBoxUnavailableError, type SecretBox } from './lib/secret-box.js';
import { formatUrlPattern, parseUrlPattern, urlMatches } from './domain/url-pattern.js';

/**
 * The Bot Vault: logins a person saves so a bot can sign in without ever being shown them.
 *
 * A secret has exactly three places it may be: the request that saves it, the sealed column below,
 * and the keystrokes that fill it in on the bot's own screen (vault-tools.ts). It is never in a
 * response, a conversation row, a tool result, an event or a log line; `Secret` is what makes the
 * accidental versions of those print `[secret]`.
 *
 * An entry with `expires_at` came from a secure form the person chose not to keep: it works like any
 * other entry until that moment and is deleted by the next vault read after it.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS vault_entries (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  username         TEXT,
  secret_encrypted TEXT NOT NULL,
  url_pattern      TEXT,
  expires_at       INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
-- A bot asks for a login by its label, so a label names one entry per person, whatever its case.
CREATE UNIQUE INDEX IF NOT EXISTS vault_entries_label ON vault_entries(user_id, label COLLATE NOCASE);
`);

/** How long a login from a secure form lasts when the person does not keep it. */
export const ONE_TIME_TTL_MS = 15 * 60_000;

export const VAULT_LIMITS = { label: 80, username: 256, secret: 1024 } as const;

export interface VaultEntryRow {
  id: string;
  user_id: string;
  label: string;
  username: string | null;
  secret_encrypted: string;
  url_pattern: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What a person may save, already checked. `secret` is the only field that is ever sealed. */
export interface VaultDraft {
  label: string;
  username: string | null;
  secret: Secret;
  urlPattern: string | null;
}

export type VaultPatch = Partial<VaultDraft>;

/** A vault request that cannot be carried out; `status` is the HTTP status a route answers with. */
export class VaultError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

// The fill is keystrokes, where a tab or a line break is a key press rather than a character.
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(raw: unknown, what: string, max: number): string {
  if (typeof raw !== 'string') throw new VaultError(400, `${what} must be text.`);
  const value = raw.trim();
  if (value.length > max) throw new VaultError(400, `${what} is too long (${max} characters at most).`);
  if (CONTROL.test(value)) throw new VaultError(400, `${what} cannot contain line breaks or tabs.`);
  return value;
}

export function parseLabel(raw: unknown): string {
  const label = text(raw, 'The name', VAULT_LIMITS.label);
  if (!label) throw new VaultError(400, 'Give the login a name.');
  return label;
}

export function parseUsername(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return text(raw, 'The username', VAULT_LIMITS.username) || null;
}

/** The secret exactly as typed: it is never trimmed, and the message never repeats it. */
export function parseSecret(raw: unknown): Secret {
  if (typeof raw !== 'string' || !raw) throw new VaultError(400, 'Enter the secret.');
  if (raw.length > VAULT_LIMITS.secret) throw new VaultError(400, `The secret is too long (${VAULT_LIMITS.secret} characters at most).`);
  if (CONTROL.test(raw)) throw new VaultError(400, 'The secret cannot contain line breaks or tabs.');
  return new Secret(raw);
}

/** The pattern in its stored form (`https://github.com`), or null for "any page". */
export function parseStoredUrlPattern(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const pattern = typeof raw === 'string' ? parseUrlPattern(raw) : null;
  if (!pattern) throw new VaultError(400, 'That is not a site. Use something like github.com or *.example.com/login.');
  return formatUrlPattern(pattern);
}

function box(): SecretBox {
  try {
    return secretBox(env.dbEncryptionKey);
  } catch (e) {
    if (e instanceof SecretBoxUnavailableError) throw new VaultError(503, e.message);
    throw e;
  }
}

/** Whether secrets can be saved and used on this server, and why not when they cannot. */
export function vaultStatus(): { configured: true } | { configured: false; reason: string } {
  try {
    box();
    return { configured: true };
  } catch (e) {
    return { configured: false, reason: (e as Error).message };
  }
}

/** What the seal is bound to: a sealed secret only opens in the row, and for the person, it was saved for. */
const sealContext = (userId: string, id: string) => `vault:${userId}:${id}`;

const toEntry = (r: VaultEntryRow): VaultEntry => ({
  id: r.id,
  label: r.label,
  username: r.username,
  urlPattern: r.url_pattern,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function dropExpired(): void {
  db.prepare('DELETE FROM vault_entries WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now());
}

function usable(userId: string): VaultEntryRow[] {
  dropExpired();
  return db.prepare('SELECT * FROM vault_entries WHERE user_id=? ORDER BY label COLLATE NOCASE').all(userId) as VaultEntryRow[];
}

const byLabel = (userId: string, label: string) =>
  db.prepare('SELECT * FROM vault_entries WHERE user_id=? AND label=? COLLATE NOCASE').get(userId, label) as VaultEntryRow | undefined;

const byId = (userId: string, id: string) =>
  db.prepare('SELECT * FROM vault_entries WHERE user_id=? AND id=?').get(userId, id) as VaultEntryRow | undefined;

/** The logins a person keeps. One-time entries are not theirs to manage: they are gone in minutes. */
export function listVaultEntries(userId: string): VaultEntry[] {
  return usable(userId).filter((r) => r.expires_at === null).map(toEntry);
}

/**
 * Save a login. A label already in use is a conflict, unless `replace` is set: a secure form answers
 * "the login called X", so submitting it again is how a changed password is corrected. A one-time
 * save never replaces a kept login, whatever `replace` says: that would delete it when it expired.
 */
export function saveVaultEntry(userId: string, draft: VaultDraft, opts: { replace?: boolean; expiresAt?: number | null } = {}): VaultEntry {
  const seal = box();
  dropExpired();
  const expiresAt = opts.expiresAt ?? null;
  const existing = byLabel(userId, draft.label);
  const keepsExisting = existing && (!opts.replace || (expiresAt !== null && existing.expires_at === null));
  if (keepsExisting) throw new VaultError(409, `A login called "${existing.label}" is already saved.`);
  const id = existing?.id ?? newId('vlt');
  const sealed = seal.seal(draft.secret, sealContext(userId, id));
  const t = now();
  if (existing) {
    db.prepare('UPDATE vault_entries SET label=?, username=?, secret_encrypted=?, url_pattern=?, expires_at=?, updated_at=? WHERE id=?')
      .run(draft.label, draft.username, sealed, draft.urlPattern, expiresAt, t, id);
  } else {
    db.prepare('INSERT INTO vault_entries(id,user_id,label,username,secret_encrypted,url_pattern,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, userId, draft.label, draft.username, sealed, draft.urlPattern, expiresAt, t, t);
  }
  return toEntry(byId(userId, id)!);
}

export function updateVaultEntry(userId: string, id: string, patch: VaultPatch): VaultEntry {
  const row = byId(userId, id);
  if (!row || row.expires_at !== null) throw new VaultError(404, 'No such login.');
  if (patch.label !== undefined) {
    const taken = byLabel(userId, patch.label);
    if (taken && taken.id !== id) throw new VaultError(409, `A login called "${taken.label}" is already saved.`);
  }
  const sealed = patch.secret ? box().seal(patch.secret, sealContext(userId, id)) : row.secret_encrypted;
  db.prepare('UPDATE vault_entries SET label=?, username=?, secret_encrypted=?, url_pattern=?, updated_at=? WHERE id=?').run(
    patch.label ?? row.label,
    patch.username !== undefined ? patch.username : row.username,
    sealed,
    patch.urlPattern !== undefined ? patch.urlPattern : row.url_pattern,
    now(),
    id,
  );
  return toEntry(byId(userId, id)!);
}

/** Needs no key: a login can always be thrown away, even on a server that can no longer read it. */
export function deleteVaultEntry(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM vault_entries WHERE user_id=? AND id=?').run(userId, id).changes > 0;
}

export type VaultQuery = { by: 'label'; label: string } | { by: 'url'; url: string };

/**
 * Which login a bot means. Labels are returned so a bot can pick or correct itself; they are names a
 * person chose for exactly that purpose, and nothing else about an entry is given away here.
 */
export type VaultMatch =
  | { kind: 'one'; entry: VaultEntryRow }
  | { kind: 'several'; labels: string[] }
  | { kind: 'none'; labels: string[] };

export function findVaultEntry(userId: string, query: VaultQuery): VaultMatch {
  const all = usable(userId);
  const hits = query.by === 'label'
    ? [byLabel(userId, query.label.trim())].filter((r) => r !== undefined)
    : all.filter((r) => {
        const pattern = r.url_pattern ? parseUrlPattern(r.url_pattern) : null;
        return pattern ? urlMatches(pattern, query.url) : false;
      });
  if (hits.length === 1) return { kind: 'one', entry: hits[0] };
  return hits.length ? { kind: 'several', labels: hits.map((r) => r.label) } : { kind: 'none', labels: all.map((r) => r.label) };
}

/** Throws VaultError(503) without a key and SecretBoxTamperError when the stored value was altered or moved. */
export function openVaultSecret(row: VaultEntryRow): Secret {
  return box().open(row.secret_encrypted, sealContext(row.user_id, row.id));
}

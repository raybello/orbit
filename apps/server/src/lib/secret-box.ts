import crypto from 'node:crypto';
import { inspect } from 'node:util';

/**
 * Sealing for values that must be unreadable without the server's key, and the wrapper that keeps an
 * opened value from being printed by accident.
 *
 * AES-256-GCM with a fresh 96-bit nonce per seal. Every seal is bound to a `context` string (the
 * additional authenticated data), so a sealed value copied into another row, or another user's row,
 * fails to open exactly like one whose bytes were altered.
 */

const VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** No usable key. Nothing is sealed or opened, and no other secret stands in for it. */
export class SecretBoxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxUnavailableError';
  }
}

/** The stored value is not what this key sealed for this context: altered, moved, or sealed under another key. */
export class SecretBoxTamperError extends Error {
  constructor() {
    super('The stored secret could not be verified, so it was not used.');
    this.name = 'SecretBoxTamperError';
  }
}

/**
 * A plaintext secret in memory. Interpolating, logging or serialising it yields `[secret]`; the only
 * way to the value is `reveal()`, so every place the plaintext leaves this process is a grep away.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  /** `text` with the value removed, for a message a dependency wrote and might have echoed input into. */
  redact(text: string): string {
    if (!this.#value) return text;
    const escaped = JSON.stringify(this.#value).slice(1, -1);
    return text.split(this.#value).join('[secret]').split(escaped).join('[secret]');
  }

  toString(): string {
    return '[secret]';
  }

  toJSON(): string {
    return '[secret]';
  }

  [inspect.custom](): string {
    return '[secret]';
  }
}

export interface SecretBox {
  seal(secret: Secret, context: string): string;
  /** Throws SecretBoxTamperError for anything this key did not seal for this context. */
  open(sealed: string, context: string): Secret;
}

const KEY_HELP = 'Set DB_ENCRYPTION_KEY to 32 random bytes as 64 hex characters (openssl rand -hex 32).';

/**
 * The 32-byte key out of its text form. Only a full-strength key is accepted: a passphrase is not
 * stretched into one, because a short one would look configured while protecting nothing.
 */
export function parseSecretKey(raw: string | null | undefined): Buffer {
  const text = (raw ?? '').trim();
  if (!text) throw new SecretBoxUnavailableError(`The Vault is off: no encryption key is configured. ${KEY_HELP}`);
  const hex = /^[0-9a-f]+$/i.test(text);
  const wellFormed = hex ? text.length === KEY_BYTES * 2 : /^[A-Za-z0-9+/_-]+={0,2}$/.test(text);
  const key = Buffer.from(text, hex ? 'hex' : 'base64');
  if (!wellFormed || key.length !== KEY_BYTES) {
    throw new SecretBoxUnavailableError(`The Vault is off: the encryption key is not 32 bytes. ${KEY_HELP}`);
  }
  if (key.every((b) => b === key[0])) {
    throw new SecretBoxUnavailableError(`The Vault is off: the encryption key is a placeholder. ${KEY_HELP}`);
  }
  return key;
}

const b64 = (b: Buffer) => b.toString('base64url');

export function secretBox(rawKey: string | null | undefined): SecretBox {
  const key = parseSecretKey(rawKey);
  return {
    seal(secret, context) {
      const nonce = crypto.randomBytes(NONCE_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const body = Buffer.concat([cipher.update(secret.reveal(), 'utf8'), cipher.final()]);
      return [VERSION, b64(nonce), b64(body), b64(cipher.getAuthTag())].join('.');
    },
    open(sealed, context) {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxTamperError();
      const [nonce, body, tag] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
      // A GCM tag can be truncated and still "verify" against a shorter length; only the full tag counts.
      if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new SecretBoxTamperError();
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(tag);
        return new Secret(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
      } catch {
        throw new SecretBoxTamperError();
      }
    },
  };
}

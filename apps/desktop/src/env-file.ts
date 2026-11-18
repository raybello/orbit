/**
 * Reading and writing `.env` bodies without a dotenv dependency.
 *
 * The stack `.env` is a file people edit by hand (add an API key, pin a port), so these
 * helpers must never reorder or drop lines: they replace one line in place or append.
 */

import { randomBytes } from 'node:crypto';

export interface SecretSpec {
  key: string;
  /** Bytes of entropy; the value written is hex, so twice this many characters. */
  bytes: number;
}

/** The secrets the server refuses to start without. */
export const REQUIRED_SECRETS: SecretSpec[] = [
  { key: 'SESSION_SECRET', bytes: 32 },
  { key: 'DB_ENCRYPTION_KEY', bytes: 32 },
  { key: 'STACK_TOKEN', bytes: 32 },
  // The images compose file requires it (`${VAR:?}`), and the desktop app is the only thing
  // that generates a stack's secrets: without it here, `docker compose up` refuses to start.
  { key: 'SANDBOX_SUPERVISOR_TOKEN', bytes: 32 },
];

/**
 * The current value of KEY in a `.env` body, or null when unset/empty.
 *
 * A commented-out `# KEY=` line is not a value, which is why the match is anchored.
 */
export function envValue(envText: string, key: string): string | null {
  // [ \t], never \s: in a CRLF file `^` also matches right after a \r, and \s* would then swallow
  // the \n and reach into the next line (an installer built on a Windows checkout ships CRLF).
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=([^\\r\\n]*)`, 'm');
  const match = re.exec(envText);
  if (!match) return null;
  const value = match[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  return value || null;
}

/** Set KEY=value in a `.env` body, appending when absent. Other lines are untouched. */
export function setEnvValue(envText: string, key: string, value: string): string {
  // Same anchoring as envValue: a CRLF line break must never be part of the match, or the
  // replacement joins KEY=value onto the line above it (which is how a Windows first run used to
  // lose its generated secrets into a comment).
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[^\\r\\n]*`, 'm');
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, () => line);
  const eol = envText.includes('\r\n') ? '\r\n' : '\n';
  const base = envText === '' || envText.endsWith('\n') ? envText : `${envText}${eol}`;
  return `${base}${line}${eol}`;
}

export function missingStackSecrets(envText: string): string[] {
  return REQUIRED_SECRETS.filter((spec) => !envValue(envText, spec.key)).map((spec) => spec.key);
}

/**
 * Fill the empty required keys with fresh hex secrets.
 *
 * Returns the new text plus what was generated, so callers can log *that* a secret was
 * created without logging the secret. `generate` is injected for deterministic tests.
 */
export function fillEmptySecrets(
  envText: string,
  opts: { generate?: (bytes: number) => string } = {},
): { text: string; generated: Record<string, string> } {
  const generate = opts.generate ?? defaultGenerate;
  let text = envText;
  const generated: Record<string, string> = {};
  for (const spec of REQUIRED_SECRETS) {
    if (envValue(text, spec.key)) continue;
    const value = generate(spec.bytes);
    generated[spec.key] = value;
    text = setEnvValue(text, spec.key, value);
  }
  return { text, generated };
}

/**
 * Drop the `MAX_BOTS=4` older installers copied in from the bundled example.
 *
 * That line was a template default, not a choice: it pinned every Docker install to four bots
 * even though each bot gets a container of its own and the server's own default is ten. Four is
 * only right for an Orgo machine (four screens), so the line is left alone there. It is commented
 * out rather than deleted, so the file keeps its shape and the person can see what changed.
 */
export function migrateLegacyBotCap(envText: string): { text: string; changed: boolean } {
  if (envValue(envText, 'MAX_BOTS') !== '4') return { text: envText, changed: false };
  const kind = (envValue(envText, 'COMPUTER_KIND') ?? 'auto').toLowerCase();
  if (kind === 'orgo' || envValue(envText, 'ORGO_COMPUTER_ID')) return { text: envText, changed: false };
  const re = /^[ \t]*(?:export[ \t]+)?MAX_BOTS[ \t]*=[^\r\n]*/m;
  const text = envText.replace(
    re,
    () => '# MAX_BOTS=10   # default 10 with a container per bot; 4 with COMPUTER_KIND=orgo',
  );
  return { text, changed: true };
}

function defaultGenerate(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

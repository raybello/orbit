/**
 * The Hermes command a sign-in terminal runs, and how it is wrapped in a real terminal. Pure, so the
 * choice of command (never an arbitrary shell) and the quoting are tested without a terminal.
 */

/** Columns and rows of the sign-in terminal; the web view is sized to match. */
export const TERMINAL_SIZE = { cols: 100, rows: 30 } as const;

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,40}$/;

/**
 * Hermes' own sign-in for one provider, or its model chooser when none is named. Claude
 * subscriptions sign in with OAuth; without the flag Hermes asks for an API key. Null for a provider
 * name that is not a plain slug.
 */
export function signInArgs(provider?: string | null): string[] | null {
  if (!provider) return ['model'];
  if (!PROVIDER.test(provider)) return null;
  return ['auth', 'add', provider, ...(provider === 'anthropic' ? ['--type', 'oauth'] : [])];
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Python's pty.spawn: a pseudo-terminal that, unlike BSD `script`, works with a pipe on stdin. */
const PTY = 'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))';

/**
 * Run `argv` in a pseudo-terminal, so Hermes' prompts and menus work. The size is set before Hermes
 * starts, since nothing resizes this terminal later.
 */
export function terminalSpawn(argv: readonly string[]): { file: string; args: string[] } {
  const sized = `stty cols ${TERMINAL_SIZE.cols} rows ${TERMINAL_SIZE.rows}; exec ${argv.map(shq).join(' ')}`;
  return { file: 'python3', args: ['-c', PTY, 'sh', '-c', sized] };
}

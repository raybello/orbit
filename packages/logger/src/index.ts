/**
 * A thin, dependency-free logger shared by the server and the desktop main process.
 *
 * - Lines carry an `[orbit]` prefix (plus an optional scope, e.g. `[orbit:stack]`).
 * - `LOG_LEVEL` (debug | info | warn | error | silent) filters output; default `info`.
 * - Never throws: a hostile `console` (a packaged Electron app with no TTY) cannot
 *   take the process down.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function levelFromEnv(value: string | undefined): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' || v === 'silent' ? v : 'info';
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** A logger that tags every line with a scope, e.g. `stack`. */
  child(scope: string): Logger;
  readonly level: LogLevel;
  setLevel(level: LogLevel): void;
}

function format(scope: string | null): string {
  return scope ? `[orbit:${scope}]` : '[orbit]';
}

export function createLogger(opts: { scope?: string; level?: LogLevel } = {}): Logger {
  let level: LogLevel = opts.level ?? levelFromEnv(process.env.LOG_LEVEL);
  const prefix = format(opts.scope ?? null);

  const at = (lvl: Exclude<LogLevel, 'silent'>) => (...args: unknown[]) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const sink = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    try { sink(prefix, ...args); } catch { /* a broken console must not crash the app */ }
  };

  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (scope: string) => createLogger({ scope: opts.scope ? `${opts.scope}:${scope}` : scope, level }),
    get level() { return level; },
    setLevel(next: LogLevel) { level = next; },
  };
}

/** The default logger: `[orbit] …`. */
export const log = createLogger();

export default log;

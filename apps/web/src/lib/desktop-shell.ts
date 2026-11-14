/**
 * Where the window controls come from.
 *
 * In a browser, the app draws its own macOS-style dots so the shell looks like a window.
 * In the desktop app the OS draws real controls over the same corner (the main window uses
 * `titleBarStyle: 'hiddenInset'` on macOS), so drawing ours as well shows two sets.
 */

/** The parts of the environment the decision depends on, so it can be tested without a DOM. */
export interface ShellEnvironment {
  /** `navigator.userAgent`. Electron's default UA carries `Electron/<version>`. */
  userAgent?: string;
  /** True when the page marked itself as running in the desktop shell (`data-orbit-desktop`). */
  marked?: boolean;
}

/**
 * True when the operating system draws the window controls, so the web chrome must not.
 *
 * Both signals are checked: the UA survives any page in the desktop app, and the document
 * marker covers a build that hides or overrides the UA.
 */
export function hasNativeWindowControls(env: ShellEnvironment = currentEnvironment()): boolean {
  if (env.marked) return true;
  return /\bElectron\//i.test(env.userAgent ?? '');
}

/** Read the live environment (browser or Electron renderer). */
export function currentEnvironment(): ShellEnvironment {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return {};
  return {
    userAgent: navigator.userAgent,
    marked: document.documentElement?.hasAttribute('data-orbit-desktop') ?? false,
  };
}

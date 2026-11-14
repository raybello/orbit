/**
 * The Hermes step of first-run, as seen from the main process.
 *
 * The setup window owns the UI; this module owns the ordering (install → API key → MCP
 * wiring) and streams the installer's own output into the window as it happens, because a
 * silent 60-second download reads as a hang.
 */

import type { WebContents } from 'electron';
import { createLogger } from '@orbit/logger';
import { IPC, type HermesStatus } from './shared/api';
import {
  detectHermes,
  ensureHermesApiKey,
  installHermes,
  wireHermesMcp,
  type HermesDeps,
} from './hermes-setup';

const log = createLogger({ scope: 'hermes' });

/** Send a progress line to a renderer that may already be closing. */
export function progressSink(target: WebContents | null): (line: string) => void {
  return (line: string) => {
    log.info(line);
    try {
      if (target && !target.isDestroyed()) target.send(IPC.hermesInstallProgress, line);
    } catch {
      /* window closed mid-install */
    }
  };
}

export interface HermesSetupResult extends HermesStatus {
  apiKeyGenerated: boolean;
}

/**
 * Install Hermes if it is missing, make sure an API key exists, and return the status the
 * window should show.
 */
export async function runHermesSetup(
  target: WebContents | null,
  deps: HermesDeps = {},
): Promise<HermesSetupResult> {
  const say = progressSink(target);
  let status = await detectHermes(deps.env ?? process.env, deps);
  if (!status.found) {
    status = await installHermes(say, deps);
  }
  const key = ensureHermesApiKey(deps);
  return { ...status, apiKeyGenerated: key.generated };
}

/**
 * After the stack answers: point `~/.hermes/config.yaml` at this server's MCP endpoint.
 * Best effort — a failure is logged and reported, never fatal to startup.
 */
export function wireMcpForServer(
  token: string,
  serverUrl: string,
  deps: HermesDeps = {},
): { ok: boolean; error?: string } {
  try {
    wireHermesMcp(token, deps, { serverUrl });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('could not wire the Orbit MCP server into Hermes', message);
    return { ok: false, error: message };
  }
}

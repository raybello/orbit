import { useEffect } from 'react';
import type { Bot, DeepLink } from '@orbit/contracts';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { prefillDraft } from './composer-drafts';

/**
 * `orbit://app/v1/prompt` links, as the desktop app hands them over (main parses them with the shared
 * parser in @orbit/contracts). Opening one shows the Bot's chat and offers its text in the composer;
 * it never sends.
 */

declare global {
  interface Window {
    /** The desktop preload bridge; only the part this module uses, which older builds lack. */
    orbitDesktop?: { onDeepLink?: (cb: (link: DeepLink) => void) => () => void };
  }
}

/** The Bot a link opens: the one it names, else the primary (also when the named one is gone). */
export function deepLinkTarget(bots: readonly Bot[], link: DeepLink): string | null {
  const named = link.botId ? bots.find((b) => b.id === link.botId) : undefined;
  return (named ?? bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
}

export async function openDeepLink(link: DeepLink): Promise<void> {
  if (!useStore.getState().bots.length) await useStore.getState().loadBots();
  const botId = deepLinkTarget(useStore.getState().bots, link);
  if (!botId) return;
  const ui = useConfigUI.getState();
  ui.closeBotSettings();
  ui.closeAppSettings();
  ui.setNavSection('chat');
  ui.setView('chat');
  useStore.getState().setModal(null);
  useStore.getState().selectBot(botId);
  prefillDraft(botId, link.text);
}

/** Listen for links from the desktop app for as long as the signed-in shell is mounted. */
export function useDeepLinks() {
  useEffect(() => window.orbitDesktop?.onDeepLink?.((link) => {
    openDeepLink(link).catch((e) => console.error('[deep-link]', e));
  }), []);
}

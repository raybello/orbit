import { useEffect } from 'react';
import { deepLinkTarget, type DeepLink } from '@orbit/contracts';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { prefillDraft } from './composer-drafts';
import './desktop'; // declares window.orbitDesktop

/**
 * `orbit://app/v1/prompt` links, as the desktop app hands them over (main parses them with the shared
 * parser in @orbit/contracts). Opening one shows the Bot's chat and offers its text in the composer;
 * it never sends.
 */

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

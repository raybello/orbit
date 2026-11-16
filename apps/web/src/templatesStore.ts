import { create } from 'zustand';
import type { Bot } from '@orbit/contracts';
import { useStore } from './store';
import { useConfigUI } from './configStore';
import { configApi } from './lib/configApi';

/** Which templates surface is open. Kept apart from store.ts, like configStore.ts. */
export type TemplatesView =
  | { kind: 'gallery' }
  /** `from` decides whether the detail offers a way back to the gallery. */
  | { kind: 'detail'; templateId: string; from: 'gallery' | 'link' }
  | { kind: 'share'; botId: string }
  | null;

interface TemplatesUI {
  view: TemplatesView;
  open(view: TemplatesView): void;
  close(): void;
}

export const useTemplatesUI = create<TemplatesUI>((set) => ({
  view: null,
  open: (view) => set({ view }),
  close: () => set({ view: null }),
}));

const PENDING = 'orbit.pendingTemplate';

/**
 * A share link (`/?template=<id>`) can arrive before sign-in, and the Google round trip lands back on
 * `/` without the query, so the id waits in session storage until the signed-in shell takes it.
 */
function capturePendingTemplate() {
  try {
    const url = new URL(window.location.href);
    const id = url.searchParams.get('template');
    if (!id) return;
    sessionStorage.setItem(PENDING, id);
    url.searchParams.delete('template');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch { /* storage blocked: the link still works while the query is there */ }
}
capturePendingTemplate();

export function takePendingTemplate(): string | null {
  try {
    const id = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    return id;
  } catch {
    return null;
  }
}

/** A Bot that just appeared (duplicated or installed): put it in the roster and open its chat. */
export function openNewBot(bot: Bot) {
  const st = useStore.getState();
  st.set({ bots: st.bots.some((b) => b.id === bot.id) ? st.bots : [...st.bots, bot] });
  useConfigUI.getState().setNavSection('chat');
  st.selectBot(bot.id);
  // A new Bot inherits the primary Bot's credentials; that can take a moment, so nobody waits on it.
  void configApi.syncEngineAuth().catch(() => {});
}

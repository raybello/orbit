import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Bot, DeepLink } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    send: vi.fn(async () => ({ row: {} })),
    interrupt: vi.fn(async () => ({ ok: true })),
    fresh: vi.fn(async () => ({ ok: true })),
    uploadAttachment: vi.fn(async () => ({ path: 'x', filename: 'x', mediaType: 'text/plain' })),
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
    bots: vi.fn(async () => ({ bots: [], live: [] })),
  },
}));

import { api } from '../lib/api';
import { useSelectedBot, useStore } from '../store';
import { Composer } from '../components/Composer';
import { useDeepLinks } from '../lib/deep-links';

function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud', voiceModel: 'piper-lessac-medium',
    model: null, provider: null, initiative: 'proactive', generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

/** The signed-in shell, reduced to what a link touches: the listener and the open Bot's composer. */
function Shell() {
  useDeepLinks();
  const selected = useSelectedBot();
  return selected ? <Composer bot={selected} running={false} /> : null;
}

/** Stands in for the desktop preload bridge and lets the test play the OS handing over a link. */
function desktopBridge() {
  let deliver: ((link: DeepLink) => void) | null = null;
  const off = vi.fn();
  window.orbitDesktop = { onDeepLink: (cb) => { deliver = cb; return off; } };
  return {
    off,
    open: async (link: Partial<DeepLink>) => {
      await act(async () => { deliver!({ kind: 'prompt', botId: null, text: '', ...link }); });
    },
  };
}

let n = 0;
function team() {
  n += 1;
  const atlas = bot({ id: `atlas-${n}`, name: 'Atlas', isPrimary: true });
  const scout = bot({ id: `scout-${n}`, name: 'Scout' });
  useStore.setState({ bots: [atlas, scout], selectedBotId: scout.id, transcripts: {} });
  return { atlas, scout };
}

const box = (name: string) => screen.getByRole('textbox', { name: `Message ${name}` }) as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
  delete window.orbitDesktop;
});

describe('deep links', () => {
  it('a link without an id opens the primary Bot with its text in the composer, and sends nothing', async () => {
    team();
    const bridge = desktopBridge();
    render(<Shell />);
    expect(box('Scout')).toBeTruthy();

    await bridge.open({ text: 'Plan my trip to Lisbon' });

    expect(box('Atlas').value).toBe('Plan my trip to Lisbon');
    expect(api.send).not.toHaveBeenCalled();
  });

  it('a link naming a Bot opens that Bot', async () => {
    const { atlas, scout } = team();
    useStore.setState({ selectedBotId: atlas.id });
    const bridge = desktopBridge();
    render(<Shell />);

    await bridge.open({ botId: scout.id, text: 'Find three hotels' });

    expect(useStore.getState().selectedBotId).toBe(scout.id);
    expect(box('Scout').value).toBe('Find three hotels');
  });

  it("fills the open Bot's empty composer in place", async () => {
    const { atlas } = team();
    useStore.setState({ selectedBotId: atlas.id });
    const bridge = desktopBridge();
    render(<Shell />);

    await bridge.open({ text: 'Summarize my inbox' });

    expect(box('Atlas').value).toBe('Summarize my inbox');
  });

  it('never replaces what the person already typed', async () => {
    const { atlas } = team();
    useStore.setState({ selectedBotId: atlas.id });
    const bridge = desktopBridge();
    render(<Shell />);
    fireEvent.change(box('Atlas'), { target: { value: 'my own words' } });

    await bridge.open({ text: 'from the link' });

    expect(box('Atlas').value).toBe('my own words');
  });

  it('a link naming a Bot that is gone falls back to the primary', async () => {
    team();
    const bridge = desktopBridge();
    render(<Shell />);

    await bridge.open({ botId: 'bot_deleted', text: 'hello' });

    expect(box('Atlas').value).toBe('hello');
  });

  it('stops listening when the shell unmounts', () => {
    team();
    const bridge = desktopBridge();
    const { unmount } = render(<Shell />);
    unmount();
    expect(bridge.off).toHaveBeenCalledTimes(1);
  });
});

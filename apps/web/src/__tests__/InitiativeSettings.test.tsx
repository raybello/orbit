import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, InitiativeSettings } from '@orbit/contracts';

const settings = (over: Partial<InitiativeSettings['briefing']> = {}, idleHours = 24): InitiativeSettings => ({
  idleHours,
  briefing: { routineId: 'rtn_1', enabled: false, time: '08:00', timezone: 'UTC', ...over },
});

vi.mock('../lib/configApi', () => ({
  configApi: {
    settings: vi.fn(async () => ({ memories: [], skills: [], routines: [], tasks: [], memory: { lastConsolidatedAt: null, historyChars: 0, compactAtChars: 1, lastCompaction: null } })),
    initiative: vi.fn(async () => settings()),
    setInitiative: vi.fn(async (p: { idleHours?: number; briefing?: { enabled?: boolean; time?: string } }) =>
      settings({ enabled: p.briefing?.enabled ?? false, time: p.briefing?.time ?? '08:00' }, p.idleHours ?? 24)),
    updateBot: vi.fn(async (id: string, p: Partial<Bot>) => ({ bot: { id, ...p } })),
    botPolicies: vi.fn(async () => ({ policies: [] })),
    removeBotPolicy: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../lib/api', () => ({
  api: { routines: vi.fn(async () => ({ routines: [] })), rows: vi.fn(async () => ({ generation: 1, rows: [] })), markRead: vi.fn(async () => ({ ok: true })) },
}));

import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { useConfigUI } from '../configStore';
import { BotSettingsModal } from '../components/config/BotSettingsModal';

function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud', voiceModel: 'piper-lessac-medium',
    model: null, provider: null, initiative: 'proactive', generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

function openSettings(botId: string) {
  const atlas = bot({ id: 'atlas', name: 'Atlas', isPrimary: true });
  const robin = bot({ id: 'robin', name: 'Robin', isPrimary: true });
  const scout = bot({ id: 'scout', name: 'Scout' });
  useStore.setState({ bots: [atlas, robin, scout], routines: {} });
  useConfigUI.setState({ botSettings: { botId, tab: 'general' } });
  render(<BotSettingsModal />);
}

afterEach(() => {
  cleanup();
  useConfigUI.setState({ botSettings: null });
});

describe('initiative settings', () => {
  it('appear only on the first primary Bot, the one that reaches out', async () => {
    openSettings('robin');
    expect(screen.queryByRole('radiogroup', { name: 'Initiative' })).toBeNull();
    cleanup();
    openSettings('scout');
    expect(screen.queryByRole('radiogroup', { name: 'Initiative' })).toBeNull();
    cleanup();
    openSettings('atlas');
    expect(screen.getByRole('radiogroup', { name: 'Initiative' })).toBeTruthy();
  });

  it('picking a level saves it on the Bot and explains it', async () => {
    openSettings('atlas');
    fireEvent.click(screen.getByRole('radio', { name: 'Reactive' }));

    await waitFor(() => expect(configApi.updateBot).toHaveBeenCalledWith('atlas', { initiative: 'reactive' }));
    expect(useStore.getState().bots.find((b) => b.id === 'atlas')?.initiative).toBe('reactive');
    expect(screen.getByText(/only speaks up when something broke/)).toBeTruthy();
    expect(screen.getByText('Paused while initiative is not Proactive.')).toBeTruthy();
  });

  it('turns the morning briefing on at a chosen time, in this browser’s timezone', async () => {
    openSettings('atlas');
    const time = (await screen.findByLabelText('Briefing time')) as HTMLInputElement;
    await waitFor(() => expect(time.value).toBe('08:00'));

    fireEvent.click(screen.getByRole('switch', { name: 'Morning briefing off' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Morning briefing on' })).toBeTruthy());
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(configApi.setInitiative).toHaveBeenCalledWith({ briefing: { enabled: true, timezone: tz } });

    fireEvent.change(time, { target: { value: '07:15' } });
    await act(async () => { fireEvent.blur(time); });
    expect(configApi.setInitiative).toHaveBeenLastCalledWith({ briefing: { time: '07:15', timezone: tz } });
  });

  it('saves how long a silence lasts before a check', async () => {
    openSettings('atlas');
    const idle = (await screen.findByLabelText('Check on me after')) as HTMLSelectElement;
    await waitFor(() => expect(idle.value).toBe('24'));
    fireEvent.change(idle, { target: { value: '0' } });
    await waitFor(() => expect(configApi.setInitiative).toHaveBeenLastCalledWith({ idleHours: 0 }));
  });
});

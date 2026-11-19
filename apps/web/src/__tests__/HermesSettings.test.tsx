import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public body?: unknown) { super(message); }
  },
  api: {
    bots: vi.fn(async () => ({ bots: [], live: [] })),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
  openPopup: vi.fn(),
}));
vi.mock('../lib/configApi', () => ({
  configApi: {
    hermesSettings: vi.fn(),
    saveHermesSettings: vi.fn(),
    connectedApps: vi.fn(),
    setAppAccess: vi.fn(),
  },
}));

import { ApiError } from '../lib/api';
import { configApi } from '../lib/configApi';
import { HermesSettingsPanel } from '../components/config/HermesSettingsPanel';
import { AppSettings } from '../components/config/AppSettings';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';

const hermesSettings = vi.mocked(configApi.hermesSettings);
const saveHermesSettings = vi.mocked(configApi.saveHermesSettings);
const connectedApps = vi.mocked(configApi.connectedApps);
const setAppAccess = vi.mocked(configApi.setAppAccess);

const SAVED = { env: 'OPENROUTER_API_KEY=sk-old\n', config: 'model:\n  provider: anthropic\n' };

afterEach(() => { cleanup(); vi.clearAllMocks(); useConfigUI.getState().closeAppSettings(); });

describe('Settings → API keys', () => {
  beforeEach(() => { hermesSettings.mockResolvedValue(SAVED); });

  it('edits the shared .env and saves only the file that changed', async () => {
    saveHermesSettings.mockResolvedValue({ updated: ['b1', 'b2'], restarting: 2, settings: { ...SAVED, env: 'OPENROUTER_API_KEY=sk-new\n' } });
    render(<HermesSettingsPanel />);
    const editor = await screen.findByRole('textbox', { name: '.env' });
    expect((editor as HTMLTextAreaElement).value).toBe(SAVED.env);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(editor, { target: { value: 'OPENROUTER_API_KEY=sk-new\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saveHermesSettings).toHaveBeenCalledWith({ env: 'OPENROUTER_API_KEY=sk-new\n' }));
    expect(await screen.findByText('Saved. 2 Bots updated, 2 restarting to pick it up.')).toBeTruthy();
  });

  it('names the file and line a save was refused for, and marks that line', async () => {
    saveHermesSettings.mockRejectedValue(new ApiError(400, 'Unexpected flow-seq end', { file: 'config', line: 2 }));
    render(<HermesSettingsPanel />);
    fireEvent.click(await screen.findByRole('tab', { name: 'config.yaml' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'config.yaml' }), { target: { value: 'model:\n  provider: [x\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Not saved (config.yaml, line 2): Unexpected flow-seq end');
    expect(document.querySelector('.code-editor__ln.is-error')?.textContent).toBe('2');
  });
});

describe('Settings → Connected apps', () => {
  it('lists the Bots for each app and turns one Bot off without touching the others', async () => {
    const bots = [
      { id: 'b_quill', name: 'Quill', avatarShape: 'circle', avatarColor: 'blue' },
      { id: 'b_atlas', name: 'Atlas', avatarShape: 'circle', avatarColor: 'green' },
    ] as unknown as Bot[];
    act(() => { useStore.setState({ bots }); });
    connectedApps.mockResolvedValue({ connected: ['gmail'], connectedApps: [{ slug: 'gmail', name: 'Gmail', connected: true } as never], revoked: {} });
    setAppAccess.mockResolvedValue({ ok: true, revoked: ['gmail'] });
    act(() => { useConfigUI.getState().openAppSettings('apps'); });
    render(<AppSettings />);

    expect(await screen.findByText('Every Bot can use it')).toBeTruthy();
    const quill = screen.getByRole('button', { name: 'Quill' });
    expect(quill.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(quill);

    await waitFor(() => expect(setAppAccess).toHaveBeenCalledWith('gmail', 'b_quill', false));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quill' }).getAttribute('aria-pressed')).toBe('false'));
    expect(screen.getByRole('button', { name: 'Atlas' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('1 of 2 Bots can use it')).toBeTruthy();
  });
});

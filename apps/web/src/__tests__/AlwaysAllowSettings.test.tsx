import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot } from '@orbit/contracts';

vi.mock('../lib/configApi', () => ({
  configApi: {
    updateBot: vi.fn(async (id: string, p: Partial<Bot>) => ({ bot: { id, ...p } })),
    botPolicies: vi.fn(async () => ({ policies: [{ tool: 'GMAIL_SEND_DRAFT', createdAt: 1 }] })),
    removeBotPolicy: vi.fn(async () => ({ ok: true })),
  },
}));

import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { AlwaysAllowSection } from '../components/config/AlwaysAllowSettings';

const atlas = { id: 'atlas', name: 'Atlas', alwaysAllow: false } as Bot;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('per-bot Always allow', () => {
  it('is off by default and says the bot asks for everything', async () => {
    useStore.setState({ bots: [atlas] });
    render(<AlwaysAllowSection bot={atlas} onNote={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Always allow for Atlas' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/never sends email without asking/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Kept, not used while the setting is off', { exact: false })).toBeTruthy());
  });

  it('turning it on saves it on the bot', async () => {
    useStore.setState({ bots: [atlas] });
    render(<AlwaysAllowSection bot={atlas} onNote={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Always allow for Atlas' }));
    await waitFor(() => expect(configApi.updateBot).toHaveBeenCalledWith('atlas', { alwaysAllow: true }));
    expect(useStore.getState().bots[0].alwaysAllow).toBe(true);
  });

  it('lists what was always-allowed for this bot and removes one', async () => {
    const on = { ...atlas, alwaysAllow: true };
    render(<AlwaysAllowSection bot={on} onNote={() => {}} />);
    await waitFor(() => expect(screen.getByText('Gmail: send draft')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(configApi.removeBotPolicy).toHaveBeenCalledWith('atlas', 'GMAIL_SEND_DRAFT'));
    await waitFor(() => expect(screen.queryByText('Gmail: send draft')).toBeNull());
  });
});

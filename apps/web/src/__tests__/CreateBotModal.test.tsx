import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, ModelsResponse } from '@orbit/contracts';
import { CreateBotModal } from '../components/modals/CreateBotModal';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    models: vi.fn(),
    createBot: vi.fn(),
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock('../lib/configApi', () => ({ configApi: { syncEngineAuth: vi.fn(async () => ({ synced: 0 })) } }));

const models = vi.mocked(api.models);
const createBot = vi.mocked(api.createBot);

const MODELS: ModelsResponse = {
  providers: [
    { id: 'anthropic', name: 'Claude (Anthropic)', models: ['claude-sonnet-4-6', 'claude-opus-4-1'] },
    { id: 'strata', name: 'Strata', models: ['qwen3'] },
  ],
  default: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

beforeEach(() => {
  models.mockReset().mockResolvedValue(MODELS);
  createBot.mockReset().mockImplementation(async (b) => ({ bot: { id: 'bot_new', name: b.name } as Bot }));
});

afterEach(cleanup);

const nameIt = (name: string) => fireEvent.change(screen.getByLabelText('Bot name'), { target: { value: name } });

describe('CreateBotModal model picker', () => {
  it('offers the default first, then the connected models grouped by provider', async () => {
    render(<CreateBotModal />);
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('Default (Claude Sonnet 4.6)');
    await waitFor(() => expect(select.querySelectorAll('optgroup')).toHaveLength(2));
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Claude (Anthropic)', 'Strata']);
    expect(screen.getByRole('option', { name: 'qwen3' })).toBeTruthy();
  });

  it('creates on the default when nothing is picked', async () => {
    render(<CreateBotModal />);
    nameIt('Scout');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createBot).toHaveBeenCalled());
    expect(createBot.mock.calls[0][0]).not.toHaveProperty('provider');
    expect(createBot.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('sends the picked provider and model', async () => {
    render(<CreateBotModal />);
    nameIt('Local');
    const option = (await screen.findByRole('option', { name: 'qwen3' })) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: option.value } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createBot).toHaveBeenCalled());
    expect(createBot.mock.calls[0][0]).toMatchObject({ name: 'Local', provider: 'strata', model: 'qwen3' });
  });

  it('still offers the default when the model list cannot be read', async () => {
    models.mockRejectedValue(new Error('offline'));
    render(<CreateBotModal />);
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    await waitFor(() => expect(models).toHaveBeenCalled());
    expect([...select.options].map((o) => o.textContent)).toEqual(['Default (Claude Sonnet 4.6)']);
  });
});

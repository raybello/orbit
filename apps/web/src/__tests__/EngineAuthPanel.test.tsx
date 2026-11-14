import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BotEngineAuthRow, EngineInfo } from '@orbit/contracts';
import { EngineAuthPanel } from '../components/config/EngineAuthPanel';
import { configApi } from '../lib/configApi';

vi.mock('../lib/configApi', () => ({
  configApi: {
    engineAuth: vi.fn(),
    setEngineAuth: vi.fn(),
    syncEngineAuth: vi.fn(),
    engine: vi.fn(),
  },
}));

const engineAuth = vi.mocked(configApi.engineAuth);
const setEngineAuth = vi.mocked(configApi.setEngineAuth);
const syncEngineAuth = vi.mocked(configApi.syncEngineAuth);
const engine = vi.mocked(configApi.engine);

const PRIMARY: BotEngineAuthRow = {
  botId: 'b-primary',
  name: 'Orbit',
  engine: 'primary',
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  status: 'ready',
  keysPresent: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
};

const MANAGED: BotEngineAuthRow = {
  botId: 'b-managed',
  name: 'Scout',
  engine: 'managed',
  provider: 'anthropic',
  model: 'claude-haiku-4',
  status: 'ready',
  keysPresent: [],
};

const NO_PROVIDERS: EngineInfo = {
  botId: 'b-primary',
  profile: 'default',
  status: 'ready',
  error: null,
  model: 'claude-sonnet-4',
  provider: 'anthropic',
  version: null,
  providers: [],
  ownScreen: false,
};

beforeEach(() => {
  engineAuth.mockReset().mockResolvedValue({ bots: [PRIMARY, MANAGED] });
  setEngineAuth.mockReset().mockImplementation(async (botId, patch) => {
    const row = [PRIMARY, MANAGED].find((r) => r.botId === botId) ?? PRIMARY;
    return { bot: { ...row, ...patch } };
  });
  syncEngineAuth.mockReset().mockResolvedValue({ synced: 2 });
  engine.mockReset().mockResolvedValue({ engine: NO_PROVIDERS });
});

afterEach(cleanup);

describe('EngineAuthPanel', () => {
  it('renders one row per Bot with its engine, provider and model', async () => {
    const { container } = render(<EngineAuthPanel />);

    expect(await screen.findByText('Orbit')).toBeTruthy();

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.engine-auth__row'));
    expect(rows.map((r) => r.dataset.botId)).toEqual(['b-primary', 'b-managed']);
    expect(rows[0].textContent).toContain('claude-sonnet-4');
    expect((rows[1].querySelector('input') as HTMLInputElement).value).toBe('claude-haiku-4');
    expect(rows[0].textContent).toContain('Primary');
    expect(rows[1].textContent).toContain('Managed');

    for (const label of ['Bot', 'Engine', 'Provider', 'Model', 'Credentials']) {
      expect(screen.getByRole('columnheader', { name: label })).toBeTruthy();
    }
    expect(engineAuth).toHaveBeenCalledTimes(1);
  });

  it('shows a warning badge for a Bot with no credentials and a key count for one that has them', async () => {
    const { container } = render(<EngineAuthPanel />);
    await screen.findByText('Orbit');

    const primaryRow = container.querySelector<HTMLElement>('[data-bot-id="b-primary"]');
    const managedRow = container.querySelector<HTMLElement>('[data-bot-id="b-managed"]');

    expect(primaryRow?.querySelector('.engine-auth__warn')).toBeNull();
    const keys = primaryRow?.querySelector<HTMLElement>('.engine-auth__keys');
    expect(keys?.textContent).toContain('2 keys');
    expect(keys?.getAttribute('title')).toBe('ANTHROPIC_API_KEY, OPENAI_API_KEY');

    const warn = managedRow?.querySelector<HTMLElement>('.engine-auth__warn');
    expect(warn?.textContent).toBe('No credentials');
    expect(managedRow?.querySelector('.engine-auth__keys')).toBeNull();
  });

  it('syncs every Bot and refetches the table', async () => {
    render(<EngineAuthPanel />);
    await screen.findByText('Orbit');
    expect(engineAuth).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /sync all/i }));

    await waitFor(() => expect(syncEngineAuth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(engineAuth).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /sync all/i })).toBeTruthy();
  });

  it('leaves the primary row read-only and makes managed rows editable', async () => {
    const { container } = render(<EngineAuthPanel />);
    await screen.findByText('Orbit');

    const primaryRow = container.querySelector<HTMLElement>('[data-bot-id="b-primary"]');
    const managedRow = container.querySelector<HTMLElement>('[data-bot-id="b-managed"]');

    expect(primaryRow?.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(primaryRow?.textContent).toContain('Follows the computer’s own agent');

    expect(managedRow?.querySelector('select[aria-label="Provider for Scout"]')).toBeTruthy();
    expect(managedRow?.querySelector('input[aria-label="Model for Scout"]')).toBeTruthy();
  });

  it('saves a managed model on blur and keeps the value the server returns', async () => {
    render(<EngineAuthPanel />);
    await screen.findByText('Orbit');
    setEngineAuth.mockResolvedValue({ bot: { ...MANAGED, model: 'gpt-5' } });

    const input = screen.getByLabelText('Model for Scout') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-5' } });
    fireEvent.blur(input);

    await waitFor(() => expect(setEngineAuth).toHaveBeenCalledWith('b-managed', { model: 'gpt-5' }));
    await waitFor(() => expect((screen.getByLabelText('Model for Scout') as HTMLInputElement).value).toBe('gpt-5'));
  });

  it('rolls a failed save back and says so', async () => {
    render(<EngineAuthPanel />);
    await screen.findByText('Orbit');
    setEngineAuth.mockRejectedValue(new Error('nope'));

    const input = screen.getByLabelText('Model for Scout') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-5' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('nope'));
    expect((screen.getByLabelText('Model for Scout') as HTMLInputElement).value).toBe('claude-haiku-4');
  });

  it('offers a retry when the table cannot load', async () => {
    engineAuth.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ bots: [PRIMARY] });
    render(<EngineAuthPanel />);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Orbit')).toBeTruthy();
    expect(engineAuth).toHaveBeenCalledTimes(2);
  });
});

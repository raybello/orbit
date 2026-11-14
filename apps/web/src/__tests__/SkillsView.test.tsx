import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, SkillEntry } from '@orbit/contracts';
import { SkillsView } from '../components/SkillsView';
import { useStore } from '../store';

vi.mock('../lib/api', () => ({
  api: { skills: vi.fn(), setSkillEnabled: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

// Imported after the mock so `api` is the mocked object.
import { api } from '../lib/api';

const mocked = vi.mocked(api);

/** Hermes is the primary agent; Scout and Archivist are managed. */
const skill = (name: string, over: Partial<SkillEntry> = {}): SkillEntry => ({
  name,
  type: 'http',
  url: `https://mcp.example.com/${name}`,
  description: `${name} tools for the team`,
  primaryEnabled: true,
  bots: [
    { botId: 'b-primary', botName: 'Hermes', enabled: true },
    { botId: 'b-scout', botName: 'Scout', enabled: true },
    { botId: 'b-archivist', botName: 'Archivist', enabled: false },
  ],
  ...over,
});

const SKILLS = [skill('github'), skill('linear')];

const sw = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;
const checked = (name: string) => sw(name).getAttribute('aria-checked');
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

beforeEach(() => {
  useStore.setState({
    bots: [
      { id: 'b-primary', name: 'Hermes', isPrimary: true },
      { id: 'b-scout', name: 'Scout', isPrimary: false },
      { id: 'b-archivist', name: 'Archivist', isPrimary: false },
    ] as unknown as Bot[],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useStore.setState({ bots: [] });
});

describe('SkillsView', () => {
  it('renders every skill from the api and auto-selects the first one', async () => {
    mocked.skills.mockResolvedValue({ skills: SKILLS });
    const { container } = render(<SkillsView />);

    expect(await screen.findByText('https://mcp.example.com/github')).toBeTruthy();

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.skills-row'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('github');
    expect(rows[0].textContent).toContain('HTTP');
    expect(rows[0].textContent).toContain('2 Bots');
    expect(rows[0].className).toContain('is-active');
    expect(rows[0].getAttribute('aria-current')).toBe('true');
    expect(rows[1].getAttribute('aria-current')).toBeNull();
  });

  it('shows the selected skill’s bots when another skill is clicked', async () => {
    mocked.skills.mockResolvedValue({ skills: SKILLS });
    render(<SkillsView />);
    await screen.findByText('https://mcp.example.com/github');

    fireEvent.click(row('linear'));

    expect(screen.getByText('https://mcp.example.com/linear')).toBeTruthy();
    expect(screen.queryByText('https://mcp.example.com/github')).toBeNull();
    expect(sw('linear for Scout')).toBeTruthy();
    expect(sw('linear for Archivist')).toBeTruthy();
    expect(row('linear').className).toContain('is-active');
  });

  it('toggles a managed bot optimistically and calls setSkillEnabled', async () => {
    let resolveToggle!: (v: { skill: SkillEntry }) => void;
    mocked.skills.mockResolvedValue({ skills: SKILLS });
    mocked.setSkillEnabled.mockImplementation(
      () => new Promise((res) => { resolveToggle = res; }),
    );
    render(<SkillsView />);
    await screen.findByText('https://mcp.example.com/github');

    expect(checked('github for Scout')).toBe('true');
    fireEvent.click(sw('github for Scout'));

    // Optimistic: the switch flips before the write lands.
    expect(checked('github for Scout')).toBe('false');
    expect(mocked.setSkillEnabled).toHaveBeenCalledTimes(1);
    expect(mocked.setSkillEnabled).toHaveBeenCalledWith('b-scout', 'github', false);

    await act(async () => {
      resolveToggle({ skill: skill('github', {
        bots: [
          { botId: 'b-primary', botName: 'Hermes', enabled: true },
          { botId: 'b-scout', botName: 'Scout', enabled: false },
          { botId: 'b-archivist', botName: 'Archivist', enabled: false },
        ],
      }) });
    });

    expect(checked('github for Scout')).toBe('false');
    expect(sw('github for Scout').disabled).toBe(false);
  });

  it('locks the primary agent’s switch on with a Primary tag', async () => {
    mocked.skills.mockResolvedValue({ skills: SKILLS });
    const { container } = render(<SkillsView />);
    await screen.findByText('https://mcp.example.com/github');

    const primary = sw('github for Hermes');
    expect(primary.disabled).toBe(true);
    expect(primary.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Primary')).toBeTruthy();

    fireEvent.click(primary);
    expect(mocked.setSkillEnabled).not.toHaveBeenCalled();
    expect(checked('github for Hermes')).toBe('true');

    // Primary sorts to the top of the list.
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.skills-bot'));
    expect(rows[0].textContent).toContain('Hermes');
    expect(rows[0].className).toContain('is-primary');
  });

  it('reverts the switch and shows an inline error when the write fails', async () => {
    let rejectToggle!: (e: Error) => void;
    mocked.skills.mockResolvedValue({ skills: SKILLS });
    mocked.setSkillEnabled.mockImplementation(
      () => new Promise((_, rej) => { rejectToggle = rej; }),
    );
    render(<SkillsView />);
    await screen.findByText('https://mcp.example.com/github');

    fireEvent.click(sw('github for Scout'));
    expect(checked('github for Scout')).toBe('false');

    await act(async () => {
      rejectToggle(new Error('config.yaml is read-only'));
    });

    await waitFor(() => {
      expect(checked('github for Scout')).toBe('true');
      expect(screen.getByText(/config\.yaml is read-only/)).toBeTruthy();
    });
    expect(screen.getByRole('alert').textContent).toContain('Scout');
    expect(sw('github for Scout').disabled).toBe(false);
  });

  it('shows the empty state when the primary agent has no skills', async () => {
    mocked.skills.mockResolvedValue({ skills: [] });
    render(<SkillsView />);

    expect(await screen.findByText(/No skills configured in the primary agent's config/)).toBeTruthy();
  });

  it('shows an error with Retry, and retrying refetches', async () => {
    mocked.skills.mockRejectedValueOnce(new Error('network down'));
    render(<SkillsView />);

    expect(await screen.findByText('network down')).toBeTruthy();

    mocked.skills.mockResolvedValueOnce({ skills: SKILLS });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('https://mcp.example.com/github')).toBeTruthy();
    expect(mocked.skills).toHaveBeenCalledTimes(2);
  });
});

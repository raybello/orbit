import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Bot, BotComputerStatus } from '@orbit/contracts';
import { ComputersView, POLL_MS } from '../components/ComputersView';
import { api } from '../lib/api';
import { useStore } from '../store';

/**
 * The view renders each bot's avatar from the roster, so the store needs a couple of Bots; only the
 * avatar fields matter here.
 */
vi.mock('../lib/api', () => ({
  api: {
    computers: vi.fn(),
    rows: vi.fn(),
    routines: vi.fn(),
    markRead: vi.fn(),
  },
}));

const mocked = vi.mocked(api);

const ROSTER = [
  { id: 'bot-scout', name: 'Scout', avatarShape: 'blob', avatarColor: 'blue' },
  { id: 'bot-mason', name: 'Mason', avatarShape: 'hex', avatarColor: 'green' },
  { id: 'bot-nova', name: 'Nova', avatarShape: 'star', avatarColor: 'violet' },
  { id: 'bot-ada', name: 'Ada', avatarShape: 'cloud', avatarColor: 'orange' },
  { id: 'bot-room', name: 'The Room', avatarShape: 'square', avatarColor: 'gray' },
] as unknown as Bot[];

const computer = (botId: string, over: Partial<BotComputerStatus> = {}): BotComputerStatus => {
  const name = ROSTER.find((b) => b.id === botId)?.name ?? botId;
  return {
    botId,
    botName: name,
    kind: 'docker',
    status: 'awake',
    isRunning: false,
    vncAvailable: true,
    screenId: `${botId}-screen`,
    ...over,
  };
};

beforeEach(() => {
  useStore.setState({
    bots: ROSTER,
    selectedBotId: null,
    viewerOpen: false,
    viewerMode: 'watch',
    viewerHint: null,
  });
  mocked.computers.mockResolvedValue({ computers: [] });
  mocked.rows.mockResolvedValue({ generation: 1, rows: [] });
  mocked.routines.mockResolvedValue({ routines: [] });
  mocked.markRead.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ComputersView', () => {
  it('renders a card for every bot that has a computer, with its name', async () => {
    mocked.computers.mockResolvedValue({
      computers: [
        computer('bot-scout'),
        computer('bot-mason', { kind: 'orgo', status: 'sleeping' }),
        computer('bot-nova', { status: 'starting' }),
      ],
    });

    render(<ComputersView />);

    expect(await screen.findByText('Scout')).toBeTruthy();
    expect(screen.getByText('Mason')).toBeTruthy();
    expect(screen.getByText('Nova')).toBeTruthy();
    expect(document.querySelectorAll('.computer-card')).toHaveLength(3);
    expect(screen.getByText('3 computers')).toBeTruthy();
  });

  it('leaves bots without a computer out of the grid and counts them below it', async () => {
    mocked.computers.mockResolvedValue({
      computers: [computer('bot-scout'), computer('bot-room', { kind: 'none', vncAvailable: false, screenId: null })],
    });

    render(<ComputersView />);

    expect(await screen.findByText('Scout')).toBeTruthy();
    expect(document.querySelectorAll('.computer-card')).toHaveLength(1);
    expect(screen.queryByText('The Room')).toBeNull();
    expect(screen.getByText('1 Bot has no computer')).toBeTruthy();
    expect(screen.getByText('1 computer')).toBeTruthy();
  });

  it('shows the empty state when no bot has a computer', async () => {
    mocked.computers.mockResolvedValue({ computers: [] });

    render(<ComputersView />);

    expect(await screen.findByText('No Bots have a computer yet.')).toBeTruthy();
    expect(document.querySelectorAll('.computer-card')).toHaveLength(0);
    expect(screen.getByText('0 computers')).toBeTruthy();
  });

  it('maps each server status to its badge label and tone', async () => {
    mocked.computers.mockResolvedValue({
      computers: [
        computer('bot-scout', { status: 'awake' }),
        computer('bot-mason', { status: 'sleeping' }),
        computer('bot-nova', { status: 'starting' }),
        computer('bot-ada', { status: 'unknown' }),
      ],
    });

    const { container } = render(<ComputersView />);
    await screen.findByText('Scout');

    const badges = Array.from(container.querySelectorAll<HTMLElement>('.computer-card__badge'));
    expect(badges.map((b) => b.textContent)).toEqual(['Awake', 'Sleeping', 'Starting', 'Unknown']);
    expect(badges.map((b) => b.className.match(/is-\w+/)?.[0])).toEqual([
      'is-awake', 'is-sleeping', 'is-starting', 'is-unknown',
    ]);
  });

  it('shows a Working chip only for a bot that is in a turn', async () => {
    mocked.computers.mockResolvedValue({
      computers: [computer('bot-scout', { isRunning: true }), computer('bot-mason')],
    });

    render(<ComputersView />);
    await screen.findByText('Scout');

    expect(screen.getAllByText('Working')).toHaveLength(1);
  });

  it('selects the bot and opens the viewer when Open is pressed', async () => {
    mocked.computers.mockResolvedValue({ computers: [computer('bot-mason', { status: 'sleeping' })] });

    render(<ComputersView />);
    await screen.findByText('Mason');

    fireEvent.click(screen.getByRole('button', { name: /open mason’s computer/i }));

    const state = useStore.getState();
    expect(state.selectedBotId).toBe('bot-mason');
    expect(state.viewerOpen).toBe(true);
    expect(state.viewerMode).toBe('watch');
  });

  it('disables Open and says No screen when the bot has no VNC', async () => {
    mocked.computers.mockResolvedValue({
      computers: [computer('bot-scout', { vncAvailable: false, screenId: null, status: 'sleeping' })],
    });

    const { container } = render(<ComputersView />);
    await screen.findByText('Scout');

    const open = container.querySelector<HTMLButtonElement>('.computer-card__open');
    expect(open?.disabled).toBe(true);
    expect(open?.textContent).toBe('No screen');
    expect(screen.getAllByText('No screen').length).toBeGreaterThanOrEqual(1);

    fireEvent.click(open as HTMLButtonElement);
    expect(useStore.getState().viewerOpen).toBe(false);
  });

  it('shows the error and recovers on Retry', async () => {
    mocked.computers
      .mockRejectedValueOnce(new Error('Computers are unreachable.'))
      .mockResolvedValueOnce({ computers: [computer('bot-scout')] });

    render(<ComputersView />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Computers are unreachable.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Scout')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocked.computers).toHaveBeenCalledTimes(2);
  });

  it('refreshes on demand', async () => {
    render(<ComputersView />);
    await screen.findByText('No Bots have a computer yet.');

    mocked.computers.mockResolvedValue({ computers: [computer('bot-nova')] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh computers' }));

    expect(await screen.findByText('Nova')).toBeTruthy();
    expect(mocked.computers).toHaveBeenCalledTimes(2);
  });

  it('polls every 15 seconds while mounted and stops on unmount', async () => {
    vi.useFakeTimers();
    mocked.computers.mockResolvedValue({ computers: [computer('bot-scout')] });

    const { unmount } = render(<ComputersView />);
    await act(async () => { await Promise.resolve(); });
    expect(mocked.computers).toHaveBeenCalledTimes(1);
    expect(POLL_MS).toBe(15_000);

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(mocked.computers).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
    expect(mocked.computers).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    roomMembers: vi.fn(async () => ({
      members: [
        { id: 'a', name: 'Scout', label: '', avatarShape: 'blob', avatarColor: 'blue' },
        { id: 'b', name: 'Ruby', label: '', avatarShape: 'blob', avatarColor: 'pink' },
      ],
    })),
    setRoomMembers: vi.fn(async () => ({ ok: true, members: [] })),
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
    deleteRoom: vi.fn(async () => ({ ok: true })),
    bots: vi.fn(async () => ({ bots: [], live: [] })),
  },
}));
vi.mock('../lib/configApi', () => ({ configApi: { deleteBot: vi.fn(async () => ({ ok: true })) } }));

import { api } from '../lib/api';
import { ConvHeader } from '../components/ConvHeader';
import { DetailsPanel } from '../components/DetailsPanel';
import { useStore } from '../store';

function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud' as const, voiceModel: 'piper-lessac-medium',
    model: null, provider: null, initiative: 'proactive', generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

const ROOM = bot({ id: 'room_a', name: 'Design sync', kind: 'room', avatarColor: 'gray' });
const AGENT = bot({ id: 'a', name: 'Scout' });
const base = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...base, bots: [AGENT, ROOM], selectedBotId: ROOM.id, detailsOpen: true, mutedRooms: [] });
});

afterEach(cleanup);

/**
 * A group chat's details are the group itself: the people, mute and leave. A one-to-one chat has
 * none of those, and the group panel has no engine/screen tabs because a room owns no computer.
 */
describe('group chat details', () => {
  it('shows people and the group options instead of the bot tabs', async () => {
    const { container } = render(<DetailsPanel />);

    expect(await screen.findByText('Group chat · 2 bots')).toBeTruthy();
    expect(screen.getByText('People')).toBeTruthy();
    expect(await screen.findByText('Scout')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Mute chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Leave/ })).toBeTruthy();
    expect(container.querySelectorAll('[role="tab"]').length).toBe(0);
    expect(screen.queryByText('Engine')).toBeNull();
  });

  it('mutes the group and remembers it', () => {
    render(<DetailsPanel />);
    const toggle = screen.getByRole('switch', { name: 'Mute chat' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    toggle.click();
    expect(useStore.getState().mutedRooms).toEqual([ROOM.id]);
  });

  it('asks before leaving, then deletes the group and lands on another chat', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.bots).mockResolvedValue({ bots: [AGENT], live: [] });
    render(<DetailsPanel />);

    fireEvent.click(screen.getByRole('button', { name: /Leave/ }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('Design sync');
    await waitFor(() => expect(useStore.getState().selectedBotId).toBe(AGENT.id));
    expect(api.deleteRoom).toHaveBeenCalledWith(ROOM.id);
    expect(useStore.getState().bots.map((b) => b.id)).toEqual([AGENT.id]);
    expect(useStore.getState().detailsOpen).toBe(false);
  });

  it('keeps the group when the person cancels', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DetailsPanel />);

    fireEvent.click(screen.getByRole('button', { name: /Leave/ }));

    expect(api.deleteRoom).not.toHaveBeenCalled();
    expect(useStore.getState().selectedBotId).toBe(ROOM.id);
  });

  it('shows why a delete failed and keeps the group open', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.deleteRoom).mockRejectedValueOnce(new Error('not found'));
    render(<DetailsPanel />);

    fireEvent.click(screen.getByRole('button', { name: /Leave/ }));

    expect(await screen.findByText('not found')).toBeTruthy();
    expect(useStore.getState().selectedBotId).toBe(ROOM.id);
    expect(screen.getByRole('button', { name: 'Leave' })).toBeTruthy();
  });

  it('drops a group deleted on another device from the roster, the feed and the mute list', async () => {
    useStore.setState({
      mutedRooms: [ROOM.id],
      recentActivity: [
        { botId: ROOM.id, botName: 'Design sync', kind: 'message', preview: 'Kickoff notes', at: 2_000, seq: 4 },
        { botId: AGENT.id, botName: 'Scout', kind: 'message', preview: 'Numbers are in', at: 1_000, seq: 2 },
      ],
    });
    vi.mocked(api.bots).mockResolvedValue({ bots: [AGENT], live: [] });

    useStore.getState().handleEvent({ type: 'roster' });

    await waitFor(() => expect(useStore.getState().selectedBotId).toBe(AGENT.id));
    const st = useStore.getState();
    expect(st.recentActivity.map((a) => a.preview)).toEqual(['Numbers are in']);
    expect(st.mutedRooms).toEqual([]);
  });

  it('keeps the bot actions out of a one-to-one chat', () => {
    useStore.setState({ selectedBotId: AGENT.id });
    const { container } = render(<DetailsPanel />);

    expect(screen.queryByText('Leave')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Mute chat' })).toBeNull();
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual([
      'Screen', 'Activity', 'Tasks', 'Library', 'Engine',
    ]);
  });
});

describe('group chat header', () => {
  it('offers People for a group and bot settings for an agent', () => {
    const { container, unmount } = render(
      <ConvHeader bot={ROOM} running={false} activeTab="chat" onTabChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /group details/i })).toBeTruthy();
    expect(container.querySelector('.conv-header__dot')).toBeNull();
    unmount();

    render(<ConvHeader bot={AGENT} running={false} activeTab="chat" onTabChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Bot settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /group details/i })).toBeNull();
  });
});

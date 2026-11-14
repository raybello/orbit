import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot } from '@orbit/contracts';
import type { RoomMember } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    roomMembers: vi.fn(),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
    bots: vi.fn(async () => ({ bots: [], live: [] })),
  },
}));

import { api } from '../lib/api';
import { ChatListView } from '../components/ChatListView';
import { useStore } from '../store';

/** A complete Bot, so the tests only state the fields they care about. */
function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', model: null, provider: null,
    generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

function member(id: string, name: string): RoomMember {
  return { id, name, label: '', avatarShape: 'blob', avatarColor: 'green' };
}

const base = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...base, bots: [], live: {}, selectedBotId: null, modal: null, transcripts: {}, routines: {} });
  vi.mocked(api.roomMembers).mockResolvedValue({ members: [] });
});

afterEach(cleanup);

/** Row names in the order they are rendered. */
function rowNames(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.bot-row')).map((r) => r.querySelector('.bot-row__name')?.textContent);
}

describe('ChatListView', () => {
  it('lists agents and groups together, newest first, with the primary Bot pinned on top', () => {
    useStore.setState({
      bots: [
        bot({ id: 'p', name: 'Primary Bot', isPrimary: true, lastActivityAt: 100 }),
        bot({ id: 'a', name: 'Alpha', lastActivityAt: 500 }),
        bot({ id: 'g', name: 'Design Crew', kind: 'room', lastActivityAt: 400 }),
        bot({ id: 'b', name: 'Beta', lastActivityAt: 300 }),
      ],
    });
    const { container } = render(<ChatListView />);

    expect(rowNames(container)).toEqual(['Primary Bot', 'Alpha', 'Design Crew', 'Beta']);
    expect(container.querySelectorAll('.chat-list__sep')).toHaveLength(1);
    expect(container.querySelector('.group-row')?.textContent).toContain('Design Crew');
  });

  it('shows overlapping member avatars and a member-count badge on a group row', async () => {
    useStore.setState({ bots: [bot({ id: 'g', name: 'Design Crew', kind: 'room', lastActivityAt: 10 })] });
    vi.mocked(api.roomMembers).mockResolvedValue({
      members: [member('a', 'Alpha'), member('b', 'Beta'), member('c', 'Gamma'), member('d', 'Delta')],
    });

    const { container } = render(<ChatListView />);

    await waitFor(() => expect(container.querySelector('.group-row__count')?.textContent).toBe('4'));
    // Overlapping avatars are capped at three.
    expect(container.querySelectorAll('.group-avatars__item')).toHaveLength(3);
    expect(api.roomMembers).toHaveBeenCalledWith('g');
  });

  it('falls back to the group avatar when the member fetch fails, and still shows the row', async () => {
    useStore.setState({ bots: [bot({ id: 'g', name: 'Design Crew', kind: 'room' })] });
    vi.mocked(api.roomMembers).mockRejectedValue(new Error('offline'));

    const { container } = render(<ChatListView />);

    await waitFor(() => expect(api.roomMembers).toHaveBeenCalled());
    expect(container.querySelector('.group-avatars__item')).toBeNull();
    expect(container.querySelector('.group-row__count')).toBeNull();
    expect(rowNames(container)).toEqual(['Design Crew']);
  });

  it('filters the list by name as the person types, and shows an empty state when nothing matches', () => {
    useStore.setState({
      bots: [
        bot({ id: 'a', name: 'Alpha', lastActivityAt: 2 }),
        bot({ id: 'b', name: 'Beta', lastActivityAt: 1 }),
      ],
    });
    const { container } = render(<ChatListView />);
    const search = screen.getByRole('textbox', { name: 'Search chats' });

    fireEvent.change(search, { target: { value: 'BET' } });
    expect(rowNames(container)).toEqual(['Beta']);

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(container.querySelectorAll('.bot-row')).toHaveLength(0);
    expect(container.querySelector('.chat-list__empty')?.textContent).toContain('No chats match');

    fireEvent.change(search, { target: { value: '' } });
    expect(rowNames(container)).toEqual(['Alpha', 'Beta']);
  });

  it('opens the create modals from the header actions', () => {
    render(<ChatListView />);

    fireEvent.click(screen.getByRole('button', { name: 'New Group' }));
    expect(useStore.getState().modal).toBe('group');

    fireEvent.click(screen.getByRole('button', { name: 'New Bot' }));
    expect(useStore.getState().modal).toBe('create');
  });

  it('selects the chat that was clicked', () => {
    const selectBot = vi.fn();
    useStore.setState({
      selectBot,
      bots: [
        bot({ id: 'a', name: 'Alpha', lastActivityAt: 2 }),
        bot({ id: 'g', name: 'Design Crew', kind: 'room', lastActivityAt: 1 }),
      ],
    });
    render(<ChatListView />);

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    expect(selectBot).toHaveBeenCalledWith('a');

    fireEvent.click(screen.getByRole('button', { name: /Design Crew/ }));
    expect(selectBot).toHaveBeenCalledWith('g');
  });
});

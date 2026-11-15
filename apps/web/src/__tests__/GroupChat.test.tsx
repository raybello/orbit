import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  },
}));
vi.mock('../lib/configApi', () => ({ configApi: { deleteBot: vi.fn(async () => ({ ok: true })) } }));

import { ConvHeader } from '../components/ConvHeader';
import { DetailsPanel } from '../components/DetailsPanel';
import { useStore } from '../store';

function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud' as const, voiceModel: 'piper-lessac-medium',
    model: null, provider: null, generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
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
    expect(container.querySelectorAll('.details-tab').length).toBe(0);
    expect(screen.queryByText('Engine')).toBeNull();
  });

  it('mutes the group and remembers it', () => {
    render(<DetailsPanel />);
    const toggle = screen.getByRole('switch', { name: 'Mute chat' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    toggle.click();
    expect(useStore.getState().mutedRooms).toEqual([ROOM.id]);
  });

  it('keeps the bot actions out of a one-to-one chat', () => {
    useStore.setState({ selectedBotId: AGENT.id });
    const { container } = render(<DetailsPanel />);

    expect(screen.queryByText('Leave')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Mute chat' })).toBeNull();
    expect([...container.querySelectorAll('.details-tab')].map((t) => t.textContent)).toEqual([
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

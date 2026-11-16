import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Bot, Row } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    send: vi.fn(async () => ({ row: {} })),
    interrupt: vi.fn(async () => ({ ok: true })),
    fresh: vi.fn(async () => ({ ok: true })),
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
    bots: vi.fn(async () => ({ bots: [], live: [] })),
    files: vi.fn(async ({ botId }: { botId?: string }) => ({
      files: botId === 'b'
        ? [{ id: 'f-b', botId: 'b', botName: 'Ruby', type: 'library', filename: 'ruby-notes.md', path: 'ruby-notes.md', size: 10, mediaType: 'text/markdown', createdAt: 1, downloadUrl: '/api/files/f-b/download' }]
        : [{ id: 'f-a', botId: 'a', botName: 'Scout', type: 'library', filename: 'scout-plan.md', path: 'scout-plan.md', size: 10, mediaType: 'text/markdown', createdAt: 1, downloadUrl: '/api/files/f-a/download' }],
      total: 1, page: 1, pageSize: 50,
    })),
    fileUrl: (f: { downloadUrl: string }) => f.downloadUrl,
  },
}));

import { ChatView } from '../components/ChatView';
import { useStore } from '../store';

/** A complete Bot, so the tests only state the fields they care about. */
function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: 'Keeps the release train on time.', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: true, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud' as const, voiceModel: 'piper-lessac-medium',
    model: null, provider: null, generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

const SCOUT = bot({ id: 'a', name: 'Scout' });

const row = (seq: number, body: Row['body']): Row => ({
  botId: 'a', generation: 1, seq, updatedSeq: 1, kind: body.type === 'card' ? 'card' : 'message', createdAt: 1_000 * seq, body,
});

const base = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...base, bots: [], live: {}, selectedBotId: null, transcripts: {}, routines: {}, modal: null });
});

afterEach(cleanup);

describe('ChatView', () => {
  it('asks for a Bot when none is selected', () => {
    render(<ChatView />);

    expect(screen.getByText('No Bot selected.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the selected Bot with its empty conversation and a ready composer', () => {
    useStore.setState({
      bots: [SCOUT],
      selectedBotId: 'a',
      transcripts: { a: { generation: 1, bySeq: {}, loaded: true } },
    });

    const { container } = render(<ChatView />);

    expect(container.querySelector('.conv-header__name')?.textContent).toBe('Scout');
    expect(container.querySelector('.empty-chat__title')?.textContent).toBe('Scout');
    expect(container.querySelector('.empty-chat__sub')?.textContent).toBe('Keeps the release train on time.');
    expect(screen.getByRole('textbox', { name: 'Message Scout' })).toBeTruthy();
  });

  it('shows the conversation that is already in the transcript', () => {
    useStore.setState({
      bots: [SCOUT],
      selectedBotId: 'a',
      transcripts: {
        a: {
          generation: 1,
          loaded: true,
          bySeq: {
            1: row(1, { type: 'message', role: 'user', text: 'Summarise the deck' }),
            2: row(2, { type: 'message', role: 'assistant', text: 'The deck has nine slides and two appendices' }),
          },
        },
      },
    });

    render(<ChatView />);

    expect(screen.getByText('Summarise the deck')).toBeTruthy();
    expect(screen.getByText('The deck has nine slides and two appendices')).toBeTruthy();
    // A transcript with messages does not show the empty state.
    expect(screen.queryByText('Keeps the release train on time.')).toBeNull();
  });

  it("shows the sender bot’s avatar (not the channel owner’s) for inter-bot messages", () => {
    // Jeff is viewing his own thread. Atlas sends him a message via send_to_bot.
    const JEFF = bot({ id: "jeff", name: "Jeff", avatarColor: "green", avatarShape: "cloud" });
    const ATLAS = bot({ id: "atlas", name: "Atlas", avatarColor: "violet", avatarShape: "star" });
    useStore.setState({
      bots: [JEFF, ATLAS],
      selectedBotId: "jeff",
      transcripts: {
        jeff: {
          generation: 1,
          loaded: true,
          bySeq: {
            1: row(1, {
              type: "message",
              role: "user",
              text: "Hey Jeff, what is your role on the team?",
              from: { kind: "bot", id: "atlas", name: "Atlas" },
            }),
          },
        },
      },
    });

    const { container } = render(<ChatView />);

    expect(screen.getByText("Hey Jeff, what is your role on the team?")).toBeTruthy();
    // The avatar inside the message bubble must be Atlas’s (the actual sender).
    // Jeff’s avatar may appear in the conv header; scope the query to the message area only.
    const msgAvatars = container.querySelectorAll(".msg-row__avatar [role=img]");
    const atlasInMsg = Array.from(msgAvatars).find((el) => el.getAttribute("title") === "Atlas");
    const jeffInMsg = Array.from(msgAvatars).find((el) => el.getAttribute("title") === "Jeff");
    expect(atlasInMsg).toBeTruthy();
    expect(jeffInMsg).toBeFalsy();
  });

  it('shows only the selected bot’s files after switching chats on the Files tab', async () => {
    const RUBY = bot({ id: 'b', name: 'Ruby', isPrimary: false });
    useStore.setState({
      bots: [SCOUT, RUBY],
      selectedBotId: 'a',
      transcripts: { a: { generation: 1, bySeq: {}, loaded: true }, b: { generation: 1, bySeq: {}, loaded: true } },
    });
    render(<ChatView />);

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    expect(await screen.findByText('scout-plan.md')).toBeTruthy();

    act(() => useStore.setState({ selectedBotId: 'b' }));
    expect(await screen.findByText('ruby-notes.md')).toBeTruthy();
    expect(screen.queryByText('scout-plan.md')).toBeNull();
  });
});

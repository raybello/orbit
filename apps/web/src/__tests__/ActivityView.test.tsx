import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ActivityItem, Bot, LiveState, Row } from '@orbit/contracts';
import { ActivityView } from '../components/ActivityView';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';

// store.ts reaches for the network through lib/api; nothing here should hit it.
vi.mock('../lib/api', () => ({
  api: {
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
}));

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  label: '',
  description: '',
  instructions: '',
  avatarShape: 'blob',
  avatarColor: id === 'a' ? 'green' : 'violet',
  mode: 'personal',
  isPrimary: id === 'a',
  pinned: false,
  effort: 'medium',
  voice: '',
  voiceSpeed: 1,
  voiceLanguage: 'auto', voiceProvider: 'cloud' as const, voiceModel: 'piper-lessac-medium',
  model: null,
  provider: null, initiative: 'proactive',
  generation: 1,
  unread: 0,
  lastPreview: null,
  lastActivityAt: 0,
  createdAt: 0,
});

const SCOUT = bot('a', 'Scout');
const MARLOW = bot('b', 'Marlow');

const messageRow = (over: Partial<Row> & Pick<Row, 'seq'>, text: string, role: 'user' | 'assistant' = 'assistant', streaming = false): Row => ({
  botId: 'a',
  generation: 1,
  updatedSeq: 1,
  kind: 'message',
  createdAt: 1_000,
  ...over,
  body: { type: 'message', role, text, streaming },
});

const rows = (botId: string, list: Row[]) => ({ type: 'rows' as const, botId, generation: 1, rows: list });

/** The entries a person can see, top to bottom. */
const previews = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.activity-item__preview')).map((el) => el.textContent);

beforeEach(() => {
  useStore.setState({
    bots: [SCOUT, MARLOW],
    recentActivity: [],
    activitySeen: {},
    live: {},
    transcripts: {},
    selectedBotId: null,
  });
  useConfigUI.setState({ navSection: 'activity' });
});

afterEach(cleanup);

describe('ActivityView', () => {
  it('shows the empty state before anything has happened', () => {
    render(<ActivityView />);

    expect(screen.getByText('Nothing yet — messages and questions from your Bots show up here.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  });

  it('lists items newest first', () => {
    const items: ActivityItem[] = [
      { botId: 'a', botName: 'Scout', kind: 'message', preview: 'older note', at: 1_000, seq: 1 },
      { botId: 'b', botName: 'Marlow', kind: 'completed', preview: 'Finished working', at: 3_000 },
      { botId: 'a', botName: 'Scout', kind: 'message', preview: 'newest note', at: 5_000, seq: 2 },
    ];
    useStore.setState({ recentActivity: items });

    const { container } = render(<ActivityView />);

    expect(previews(container)).toEqual(['newest note', 'Finished working', 'older note']);
  });

  it('folds a run from one bot into a collapsed group showing its latest status and size', () => {
    useStore.setState({
      recentActivity: [
        { botId: 'b', botName: 'Marlow', kind: 'message', preview: 'Drafted the vendor brief', at: 1_000, seq: 1 },
        { botId: 'b', botName: 'Marlow', kind: 'message', preview: 'Sent it to legal', at: 2_000, seq: 2 },
        { botId: 'b', botName: 'Marlow', kind: 'working', preview: 'Reading the reply', at: 3_000 },
        { botId: 'a', botName: 'Scout', kind: 'message', preview: 'Numbers are in', at: 4_000, seq: 3 },
      ],
    });

    const { container } = render(<ActivityView />);

    expect(previews(container)).toEqual(['Numbers are in', 'Reading the reply']);
    expect(screen.getByText('Working')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Show 2 earlier from Marlow' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('3');
    expect(container.querySelector('.page__meta')?.textContent).toBe('4');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(previews(container)).toEqual(['Numbers are in', 'Reading the reply', 'Sent it to legal', 'Drafted the vendor brief']);

    fireEvent.click(screen.getByRole('button', { name: 'Hide 2 earlier from Marlow' }));
    expect(previews(container)).toEqual(['Numbers are in', 'Reading the reply']);
  });

  it('starts a new group when another bot interleaves', () => {
    useStore.setState({
      recentActivity: [
        { botId: 'a', botName: 'Scout', kind: 'message', preview: 'first', at: 1_000, seq: 1 },
        { botId: 'b', botName: 'Marlow', kind: 'message', preview: 'between', at: 2_000, seq: 2 },
        { botId: 'a', botName: 'Scout', kind: 'message', preview: 'second', at: 3_000, seq: 3 },
        { botId: 'a', botName: 'Scout', kind: 'message', preview: 'third', at: 4_000, seq: 4 },
      ],
    });

    const { container } = render(<ActivityView />);

    expect(previews(container)).toEqual(['third', 'between', 'first']);
    expect(screen.getByRole('button', { name: 'Show 1 earlier from Scout' })).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /earlier from/ })).toHaveLength(1);
  });

  it('groups what the filter shows and counts entries, not groups', () => {
    useStore.setState({
      recentActivity: [
        { botId: 'a', botName: 'Scout', kind: 'card', preview: 'Approve the spend?', at: 1_000, seq: 1 },
        { botId: 'a', botName: 'Scout', kind: 'message', preview: 'Spend is ready', at: 2_000, seq: 2 },
        { botId: 'a', botName: 'Scout', kind: 'card', preview: 'Pick a vendor', at: 3_000, seq: 3 },
      ],
    });

    const { container } = render(<ActivityView />);
    const count = () => container.querySelector('.page__meta')?.textContent;
    expect(count()).toBe('3');
    expect(screen.getByRole('button', { name: 'Show 2 earlier from Scout' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
    expect(count()).toBe('2');
    expect(previews(container)).toEqual(['Pick a vendor']);
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 earlier from Scout' }));
    expect(previews(container)).toEqual(['Pick a vendor', 'Approve the spend?']);
  });

  it('opens the bot from a group and from an earlier entry in it', () => {
    useStore.setState({
      recentActivity: [
        { botId: 'b', botName: 'Marlow', kind: 'message', preview: 'Earlier update', at: 1_000, seq: 1 },
        { botId: 'b', botName: 'Marlow', kind: 'message', preview: 'Latest update', at: 2_000, seq: 2 },
      ],
    });
    render(<ActivityView />);

    fireEvent.click(screen.getByText('Latest update'));
    expect(useStore.getState().selectedBotId).toBe('b');
    expect(useConfigUI.getState().navSection).toBe('chat');

    useStore.setState({ selectedBotId: null });
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 earlier from Marlow' }));
    fireEvent.click(screen.getByText('Earlier update'));
    expect(useStore.getState().selectedBotId).toBe('b');
  });

  it('shows a pending card by its question, and filters the feed', () => {
    const card: Row = {
      botId: 'a',
      generation: 1,
      seq: 4,
      updatedSeq: 1,
      kind: 'card',
      createdAt: 2_000,
      body: { type: 'card', card: 'question', question: 'Ship the release on Friday?', options: ['Yes', 'No'], status: 'pending' },
    };
    useStore.getState().handleEvent(rows('a', [card]));
    useStore.getState().handleEvent(rows('a', [messageRow({ seq: 3, createdAt: 1_500 }, 'Release notes are drafted')]));

    render(<ActivityView />);
    expect(screen.getByText('Ship the release on Friday?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
    expect(screen.getByText('Ship the release on Friday?')).toBeTruthy();
    expect(screen.queryByText('Release notes are drafted')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Messages' }));
    expect(screen.getByText('Release notes are drafted')).toBeTruthy();
    expect(screen.queryByText('Ship the release on Friday?')).toBeNull();
  });

  it('opens the bot in Chat when an item is clicked', () => {
    const selectBot = vi.spyOn(useStore.getState(), 'selectBot');
    useStore.setState({
      recentActivity: [{ botId: 'b', botName: 'Marlow', kind: 'message', preview: 'Need a decision on vendors', at: 2_000, seq: 9 }],
    });

    render(<ActivityView />);
    fireEvent.click(screen.getByRole('button', { name: /Marlow/ }));

    expect(selectBot).toHaveBeenCalledTimes(1);
    expect(selectBot).toHaveBeenCalledWith('b');
    expect(useConfigUI.getState().navSection).toBe('chat');
    expect(useStore.getState().selectedBotId).toBe('b');
  });

  it('derives feed items from rows events and ignores user and streaming messages', () => {
    useStore.getState().handleEvent(rows('a', [
      messageRow({ seq: 1, createdAt: 1_000 }, 'Please summarise the deck', 'user'),
      messageRow({ seq: 2, createdAt: 1_100 }, 'Half a thou', 'assistant', true),
      messageRow({ seq: 3, createdAt: 1_200 }, 'The deck has nine slides\nand two appendices'),
    ]));

    const feed = useStore.getState().recentActivity;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      botId: 'a',
      botName: 'Scout',
      kind: 'message',
      preview: 'The deck has nine slides and two appendices',
      at: 1_200,
      seq: 3,
    });
  });

  it('replaces an item when its row is revised, and never duplicates a repeated seq', () => {
    useStore.getState().handleEvent(rows('a', [messageRow({ seq: 5, updatedSeq: 2 }, 'Here is the summary')]));
    expect(useStore.getState().recentActivity).toHaveLength(1);

    // Same revision arriving twice (reconnect, replay) must not add a second entry.
    useStore.getState().handleEvent(rows('a', [messageRow({ seq: 5, updatedSeq: 2 }, 'Here is the summary')]));
    expect(useStore.getState().recentActivity).toHaveLength(1);

    // A newer revision of the same row replaces the preview instead of appending.
    useStore.getState().handleEvent(rows('a', [messageRow({ seq: 5, updatedSeq: 3 }, 'Here is the summary, revised')]));
    const feed = useStore.getState().recentActivity;
    expect(feed).toHaveLength(1);
    expect(feed[0].preview).toBe('Here is the summary, revised');
  });

  it('records one working and one completed entry per turn', () => {
    const running: LiveState = { botId: 'b', isRunning: true, activity: null, awaiting: null, startedAt: 7_000 };
    useStore.getState().handleEvent({ type: 'live', state: running });
    useStore.getState().handleEvent({ type: 'live', state: { ...running, activity: { kind: 'thinking', since: 7_100 } } });
    expect(useStore.getState().recentActivity.filter((a) => a.kind === 'working')).toHaveLength(1);

    useStore.getState().handleEvent({ type: 'live', state: { ...running, isRunning: false, startedAt: 7_000 } });
    useStore.getState().handleEvent({ type: 'live', state: { ...running, isRunning: false, startedAt: 7_000 } });
    const feed = useStore.getState().recentActivity;
    expect(feed.filter((a) => a.kind === 'completed')).toHaveLength(1);
    expect(feed.find((a) => a.kind === 'completed')?.botName).toBe('Marlow');
  });
});

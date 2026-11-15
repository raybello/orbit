import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CardBody, Row, RowBody } from '@orbit/contracts';

/**
 * The card components only reach the network through `api`; every decision, answer, dismissal and
 * connect goes through one of these. `openPopup` is replaced with a fake window so a test can see
 * where the sign-in popup was pointed without jsdom trying to open a real one.
 */
const h = vi.hoisted(() => {
  const popup = { location: { href: '' }, close: vi.fn() };
  return { popup };
});

vi.mock('../lib/api', () => ({
  api: {
    approve: vi.fn(async () => ({ ok: true })),
    answer: vi.fn(async () => ({ ok: true })),
    dismiss: vi.fn(async () => ({ ok: true })),
    connect: vi.fn(async () => ({ redirectUrl: 'https://accounts.example.com/oauth' })),
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
  openPopup: vi.fn(() => h.popup),
}));

import { api, openPopup } from '../lib/api';
import { ApprovalCard, CardRow, ConnectCard, DraftCard, QuestionCard } from '../components/cards/Cards';
import { useStore } from '../store';

type ApprovalBody = Extract<CardBody, { card: 'approval' }>;
type QuestionBody = Extract<CardBody, { card: 'question' }>;
type ConnectBody = Extract<CardBody, { card: 'connect' }>;
type DraftBody = Extract<CardBody, { card: 'draft' }>;

const approval = (over: Partial<ApprovalBody> = {}): ApprovalBody => ({
  type: 'card',
  card: 'approval',
  approvalId: 'ap-1',
  title: 'Create an issue in orbit-api',
  detail: 'Open “Login is broken” in the orbit-api repo',
  tool: 'github_create_issue',
  toolkit: 'github',
  args: {},
  status: 'pending',
  ...over,
});

const question = (over: Partial<QuestionBody> = {}): QuestionBody => ({
  type: 'card',
  card: 'question',
  question: 'Ship the release on Friday?',
  options: ['Yes', 'No'],
  status: 'pending',
  ...over,
});

const connect = (over: Partial<ConnectBody> = {}): ConnectBody => ({
  type: 'card',
  card: 'connect',
  toolkit: 'googlecalendar',
  toolkitName: 'Google Calendar',
  reason: 'Read your calendar to plan the week',
  status: 'pending',
  ...over,
});

const draft = (over: Partial<DraftBody> = {}): DraftBody => ({
  type: 'card',
  card: 'draft',
  channel: 'email',
  to: 'sam@example.com',
  subject: 'Friday release plan',
  text: 'Here is the plan for Friday: freeze at noon, ship at four.',
  approvalId: 'ap-2',
  status: 'pending',
  ...over,
});

/** A transcript row carrying a card body, as the server sends it. */
const rowFor = (body: RowBody, over: Partial<Row> = {}): Row => ({
  botId: 'a',
  generation: 1,
  seq: 7,
  updatedSeq: 1,
  kind: 'card',
  createdAt: 1_000,
  body,
  ...over,
});

beforeEach(() => {
  h.popup.location.href = '';
  h.popup.close.mockClear();
  useStore.setState({ user: { id: 'u1', email: 'ray@example.com', name: 'Ray Bello', avatarUrl: null }, connectionsVersion: 0 });
});

afterEach(cleanup);

describe('approval card', () => {
  it('asks about the action in plain words, naming the app and the detail', () => {
    render(<ApprovalCard body={approval()} />);

    expect(screen.getByText('Create an issue in orbit-api')).toBeTruthy();
    expect(screen.getByText('Open “Login is broken” in the orbit-api repo')).toBeTruthy();
    // The toolkit slug is humanised for the subtitle, not shown raw.
    expect(screen.getByText('GitHub')).toBeTruthy();
  });

  it('offers all three decisions and sends the one that was clicked', async () => {
    render(<ApprovalCard body={approval()} />);

    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: "Don't allow" })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(vi.mocked(api.approve)).toHaveBeenCalledTimes(1);
    expect(api.approve).toHaveBeenCalledWith('ap-1', 'allow');

    // The card disables its buttons while a decision is in flight, so wait for it to settle.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Always allow' }) as HTMLButtonElement).disabled).toBe(false),
    );

    vi.mocked(api.approve).mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(api.approve).toHaveBeenCalledWith('ap-1', 'always');

    await waitFor(() =>
      expect((screen.getByRole('button', { name: "Don't allow" }) as HTMLButtonElement).disabled).toBe(false),
    );

    vi.mocked(api.approve).mockClear();
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    expect(api.approve).toHaveBeenCalledTimes(1);
    expect(api.approve).toHaveBeenCalledWith('ap-1', 'deny');
  });

  it('shows the decision once it is no longer pending, and offers no buttons', () => {
    render(<ApprovalCard body={approval({ status: 'denied' })} />);

    expect(screen.getByText('Not allowed')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reports a failed decision to the person instead of silently doing nothing', async () => {
    vi.mocked(api.approve).mockRejectedValueOnce(new Error('Approval expired'));
    render(<ApprovalCard body={approval()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));

    await waitFor(() => expect(screen.getByText('Approval expired')).toBeTruthy());
  });
});

describe('question card', () => {
  it('shows the question, its options and how to answer', () => {
    render(<QuestionCard row={rowFor(question())} body={question()} />);

    expect(screen.getByText('Ship the release on Friday?')).toBeTruthy();
    expect(screen.getByText('Pick an option or reply in your own words')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Yes/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /No/ })).toBeTruthy();
    // Options carry their letter so they can be picked by keyboard in the transcript.
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('answers with the chosen option for this row', () => {
    render(<QuestionCard row={rowFor(question())} body={question()} />);

    expect(api.answer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /No/ }));

    expect(vi.mocked(api.answer)).toHaveBeenCalledTimes(1);
    expect(api.answer).toHaveBeenCalledWith('a', 7, 'No');
  });

  it('skips the question when Skip is clicked', () => {
    render(<QuestionCard row={rowFor(question())} body={question()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(vi.mocked(api.dismiss)).toHaveBeenCalledTimes(1);
    expect(api.dismiss).toHaveBeenCalledWith('a', 7);
  });

  it('marks an answered question as such and locks the options', () => {
    render(<QuestionCard row={rowFor(question())} body={question({ status: 'answered', answer: 'Yes' })} />);

    expect(screen.getByText('Answered')).toBeTruthy();
    const chosen = screen.getByRole('button', { name: /Yes/ }) as HTMLButtonElement;
    expect(chosen.className).toContain('is-chosen');
    expect(chosen.disabled).toBe(true);
    expect((screen.getByRole('button', { name: /No/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(api.answer).not.toHaveBeenCalled();
  });
});

describe('connect card', () => {
  it('names the app and why it is needed, then opens the sign-in page', async () => {
    render(<ConnectCard row={rowFor(connect())} body={connect()} />);

    expect(screen.getByText('Connect Google Calendar')).toBeTruthy();
    expect(screen.getByText('Read your calendar to plan the week')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(openPopup).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.connect).toHaveBeenCalledTimes(1));
    expect(api.connect).toHaveBeenCalledWith('googlecalendar', 'a', 7);
    // The popup is sent to the provider's consent page, not left blank.
    await waitFor(() => expect(h.popup.location.href).toBe('https://accounts.example.com/oauth'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Waiting for sign-in/ })).toBeTruthy());
  });

  it('skips the connection when Skip is clicked', () => {
    render(<ConnectCard row={rowFor(connect())} body={connect()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(vi.mocked(api.dismiss)).toHaveBeenCalledTimes(1);
    expect(api.dismiss).toHaveBeenCalledWith('a', 7);
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('confirms a connected app and offers nothing left to do', () => {
    render(<ConnectCard row={rowFor(connect())} body={connect({ status: 'connected' })} />);

    expect(screen.getByText('Google Calendar connected')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('draft card', () => {
  it('shows the channel, the sender, the recipient and the message to send', () => {
    const body = draft();
    render(<DraftCard body={body} />);

    expect(screen.getByText('Email')).toBeTruthy();
    expect(screen.getByText('@ray')).toBeTruthy();
    expect(screen.getByText('sam@example.com')).toBeTruthy();
    expect(screen.getByText('Friday release plan')).toBeTruthy();
    expect(screen.getByText('Here is the plan for Friday: freeze at noon, ship at four.')).toBeTruthy();
  });

  it('sends the draft through the approval it belongs to', () => {
    render(<DraftCard body={draft()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(vi.mocked(api.approve)).toHaveBeenCalledTimes(1);
    expect(api.approve).toHaveBeenCalledWith('ap-2', 'allow');
  });

  it('discards the draft when Discard is clicked', () => {
    render(<DraftCard body={draft()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(vi.mocked(api.approve)).toHaveBeenCalledTimes(1);
    expect(api.approve).toHaveBeenCalledWith('ap-2', 'deny');
  });

  it('shows a sent draft as done, with no decision left to make', () => {
    render(<DraftCard body={draft({ status: 'sent' })} />);

    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });
});

describe('card row', () => {
  it('renders each card body as the matching card', () => {
    const { container, rerender } = render(<CardRow row={rowFor(approval())} />);
    expect(container.querySelector('.approval-card')).toBeTruthy();
    expect(screen.getByText('Create an issue in orbit-api')).toBeTruthy();

    rerender(<CardRow row={rowFor(question())} />);
    expect(container.querySelector('.question-card')).toBeTruthy();

    rerender(<CardRow row={rowFor(connect())} />);
    expect(container.querySelector('.connect-card')).toBeTruthy();

    rerender(<CardRow row={rowFor(draft())} />);
    expect(container.querySelector('.draft-card')).toBeTruthy();
  });

  it('renders nothing for a non-card row', () => {
    const { container } = render(
      <CardRow row={rowFor({ type: 'message', role: 'assistant', text: 'All done' }, { kind: 'message' })} />,
    );

    expect(container.querySelector('.card')).toBeNull();
  });
});

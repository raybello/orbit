import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CardBody, EmailReview, Row } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    draftAction: vi.fn(async () => ({ card: {} })),
    approve: vi.fn(async () => ({ ok: true })),
    approvalEditing: vi.fn(async () => ({ ok: true })),
  },
}));

import { api } from '../lib/api';
import { ApprovalEmailCard, DraftEmailCard } from '../components/cards/EmailCard';

const email = (over: Partial<EmailReview> = {}): EmailReview => ({
  kind: 'email', action: 'send_draft', to: ['ada@x.test'], cc: [], bcc: [], subject: 'Plan', body: 'Hello', isHtml: false, draftId: 'd1', editable: true, ...over,
});
const draft = (e: EmailReview, status: 'pending' | 'sent' | 'discarded' = 'pending') =>
  ({ type: 'card', card: 'draft', channel: 'email', to: e.to.join(', '), subject: e.subject, text: e.body, approvalId: 'draft_d1', email: e, status }) as Extract<CardBody, { card: 'draft' }>;
const row = { botId: 'b1', seq: 7 } as Row;
const approval = (e: EmailReview, over: Partial<Extract<CardBody, { card: 'approval' }>> = {}) =>
  ({ type: 'card', card: 'approval', approvalId: 'ap1', title: 'Allow Quinn to send email?', detail: '', tool: 'GMAIL_SEND_EMAIL', args: {}, status: 'pending', offerAlways: false, review: e, ...over }) as Extract<CardBody, { card: 'approval' }>;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Email card', () => {
  it('shows a draft in full and sends it as it is', async () => {
    render(<DraftEmailCard row={row} body={draft(email())} />);
    expect(screen.getByText('ada@x.test')).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.draftAction).toHaveBeenCalledWith('b1', 7, 'send', undefined));
  });

  it('sends only what the person changed', async () => {
    render(<DraftEmailCard row={row} body={draft(email())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit email' }));
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Plan v2' } });
    fireEvent.change(screen.getByLabelText('Cc'), { target: { value: 'c@x.test, d@x.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(api.draftAction).toHaveBeenCalledWith('b1', 7, 'save', { subject: 'Plan v2', cc: ['c@x.test', 'd@x.test'] }));
  });

  it('cannot send with no recipient', () => {
    render(<DraftEmailCard row={row} body={draft(email({ to: [] }))} />);
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a sent draft shows who it went to, with no actions', () => {
    render(<DraftEmailCard row={row} body={draft(email(), 'sent')} />);
    expect(screen.getByText('Sent to ada@x.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('an approval with edits is sent as "Send with changes", and keeps the call waiting while editing', async () => {
    render(<ApprovalEmailCard body={approval(email({ action: 'send' }))} />);
    expect(screen.queryByRole('button', { name: /Always allow/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit email' }));
    await waitFor(() => expect(api.approvalEditing).toHaveBeenCalledWith('ap1'));
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello there' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send with changes' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('ap1', 'allow', { body: 'Hello there' }));
  });

  it('a reply cannot change its subject; a trusted bot offers "Always allow for <Bot>"', () => {
    render(<ApprovalEmailCard body={approval(email({ action: 'reply' }), { alwaysFor: { botId: 'b', botName: 'Quinn' }, offerAlways: true })} />);
    expect(screen.getByRole('button', { name: 'Always allow for Quinn' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit email' }));
    expect((screen.getByLabelText('Subject') as HTMLInputElement).disabled).toBe(true);
  });
});

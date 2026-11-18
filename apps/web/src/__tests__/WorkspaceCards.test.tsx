import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CardBody, DocReview, SheetReview } from '@orbit/contracts';

vi.mock('../lib/api', () => ({ api: { approve: vi.fn(async () => ({ ok: true })), approvalEditing: vi.fn(async () => ({ ok: true })) } }));

import { api } from '../lib/api';
import { DocReviewCard, FileNotice, SheetReviewCard } from '../components/cards/WorkspaceCards';

const card = (review: SheetReview | DocReview) => ({ type: 'card', card: 'approval', approvalId: 'ap1', title: 'Allow?', detail: '', tool: 'X', args: {}, status: 'pending', review }) as Extract<CardBody, { card: 'approval' }>;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Sheets and Docs cards', () => {
  it('a sheet write shows each cell before and after, and sends only the cells the person changed', async () => {
    render(<SheetReviewCard body={card({ kind: 'sheet', spreadsheetId: 's', changes: [{ cell: 'Sheet1!B2', before: '1', after: '2' }, { cell: 'Sheet1!B3', before: '', after: 'x' }], more: 4, steps: [], editable: true })} />);
    expect(screen.getByText('and 4 more cells')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New value for Sheet1!B3'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow with changes' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('ap1', 'allow', { cells: { 'Sheet1!B3': 'y' } }));
  });

  it('a doc replacement can be edited before it runs', async () => {
    render(<DocReviewCard body={card({ kind: 'doc', documentId: 'd', replace: { find: 'Q3', with: 'Q4', matchCase: true }, steps: ['Replaces 3 matches'], editable: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit change' }));
    fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'Q4 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow with changes' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('ap1', 'allow', { replaceWith: 'Q4 2026' }));
  });

  it('a created file shows its title, a link and a preview', () => {
    render(<FileNotice file={{ app: 'googlesheets', action: 'created', title: 'Budget', url: 'https://docs.google.com/spreadsheets/d/x/edit', preview: [['Item', 'Cost']] }} />);
    expect(screen.getByText('Budget')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('https://docs.google.com/spreadsheets/d/x/edit');
    expect(screen.getByText('Cost')).toBeTruthy();
  });
});

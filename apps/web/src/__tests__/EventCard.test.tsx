import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CardBody, EventFields, EventReview } from '@orbit/contracts';

vi.mock('../lib/api', () => ({ api: { approve: vi.fn(async () => ({ ok: true })), approvalEditing: vi.fn(async () => ({ ok: true })) } }));

import { api } from '../lib/api';
import { ApprovalEventCard, whenOf } from '../components/cards/EventCard';

const f = (over: Partial<EventFields> = {}): EventFields => ({ summary: 'Sync', description: '', location: '', start: '2026-11-20T15:00', end: '2026-11-20T15:30', allDay: false, timezone: 'America/Toronto', attendees: ['sam@x.test'], meet: false, ...over });
const card = (review: EventReview) => ({ type: 'card', card: 'approval', approvalId: 'ap1', title: 'Allow Quinn to change an event?', detail: '', tool: 'GOOGLECALENDAR_PATCH_EVENT', args: {}, status: 'pending', review }) as Extract<CardBody, { card: 'approval' }>;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Event card', () => {
  it('formats times as the event\'s own wall-clock time', () => {
    expect(whenOf(f())).toBe('Fri, Nov 20 · 3:00 PM – 3:30 PM');
    expect(whenOf(f({ allDay: true, start: '2026-12-24', end: '2026-12-25' }))).toBe('Thu, Dec 24 – Fri, Dec 25 · All day');
  });

  it('shows what a change was, and allows it untouched', async () => {
    render(<ApprovalEventCard body={card({ kind: 'event', action: 'update', calendarId: 'primary', eventId: 'e', before: f(), fields: f({ start: '2026-11-20T16:00', end: '2026-11-20T16:30' }), notifyGuests: true, editable: true })} />);
    expect(screen.getByText('was Fri, Nov 20 · 3:00 PM – 3:30 PM')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('ap1', 'allow', undefined));
  });

  it('sends the scope and the guest choice the person picked, and only fields they changed', async () => {
    render(<ApprovalEventCard body={card({ kind: 'event', action: 'update', calendarId: 'primary', eventId: 'e', before: f(), fields: f(), recurring: { scope: 'this' }, notifyGuests: true, editable: true })} />);
    fireEvent.click(screen.getByLabelText('All events'));
    fireEvent.click(screen.getByLabelText('Email guests about this'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit event' }));
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Room 9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow with changes' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('ap1', 'allow', { location: 'Room 9', scope: 'all', notifyGuests: false }));
  });

  it('a delete is a red Delete, with nothing to edit', () => {
    render(<ApprovalEventCard body={card({ kind: 'event', action: 'delete', calendarId: 'primary', eventId: 'e', before: f(), notifyGuests: true, editable: true })} />);
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('btn--danger');
    expect(screen.queryByRole('button', { name: 'Edit event' })).toBeNull();
  });
});

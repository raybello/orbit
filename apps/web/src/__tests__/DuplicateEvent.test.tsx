import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, DuplicateDefaults } from '@orbit/contracts';

vi.mock('../lib/api', () => ({ api: { createRoutine: vi.fn(async () => ({ routine: {} })) } }));

import { api } from '../lib/api';
import { useStore } from '../store';
import { CreateCalendarEventModal } from '../components/modals/CreateCalendarEventModal';

const atlas = { id: 'b1', name: 'Atlas', kind: 'agent', isPrimary: true } as Bot;
const start = new Date(2026, 10, 19, 15, 0);
const defaults = (over: Partial<DuplicateDefaults> = {}): DuplicateDefaults => ({ title: 'Design review', start: start.toISOString(), timezone: 'America/Toronto', prompt: 'Prepare me for “Design review”', recurring: false, cron: null, ...over });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Duplicate as Orbit event', () => {
  it('starts from the Google event, and "15 min before" is what is saved, linked to its parent', async () => {
    useStore.setState({ bots: [atlas], selectedBotId: 'b1' });
    render(<CreateCalendarEventModal initialDate={start} duplicate={{ key: 'g1', defaults: defaults() }} onClose={() => {}} onSaved={() => {}} />);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Design review');
    fireEvent.click(screen.getByRole('radio', { name: '15 min before' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalled());
    const req = vi.mocked(api.createRoutine).mock.calls[0][0];
    expect(req.parentEventKey).toBe('g1');
    expect(req.eventDate).toBe(new Date(start.getTime() - 15 * 60_000).toISOString());
    expect(req.prompt).toBe('Prepare me for “Design review”');
  });

  it('a repeating parent can repeat too, at its own time and timezone', async () => {
    useStore.setState({ bots: [atlas], selectedBotId: 'b1' });
    render(<CreateCalendarEventModal initialDate={start} duplicate={{ key: 'g1', defaults: defaults({ recurring: true, cron: '0 15 * * 4' }) }} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Recurring' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalled());
    const req = vi.mocked(api.createRoutine).mock.calls[0][0];
    expect([req.eventType, req.schedule, req.timezone]).toEqual(['recurring', '0 15 * * 4', 'America/Toronto']);
  });

  it('a repeat cron cannot express stays one-time and says why', () => {
    useStore.setState({ bots: [atlas], selectedBotId: 'b1' });
    render(<CreateCalendarEventModal initialDate={start} duplicate={{ key: 'g1', defaults: defaults({ recurring: true, cron: null, cronReason: 'It repeats every 2 weeks, which cron cannot express.' }) }} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByRole('radio', { name: 'Recurring' })).toBeNull();
    expect(screen.getByText('It repeats every 2 weeks, which cron cannot express.')).toBeTruthy();
  });
});

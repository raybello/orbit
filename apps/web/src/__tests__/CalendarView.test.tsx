import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bot, CalendarEvent } from '@orbit/contracts';
import { api } from '../lib/api';
import { useStore } from '../store';
import { CalendarView } from '../components/CalendarView';

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
  openPopup: vi.fn(),
  api: { calendar: vi.fn(), createRoutine: vi.fn() },
}));

const BOT_A: Bot = {
  id: 'bot-ada', name: 'Ada', label: '', description: '', instructions: '',
  avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', isPrimary: true, kind: 'agent',
  pinned: false, effort: 'medium', voice: '', voiceSpeed: 1, voiceLanguage: 'auto',
  model: null, provider: null, generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
};

const BOT_B: Bot = { ...BOT_A, id: 'bot-grace', name: 'Grace', avatarColor: 'green', isPrimary: false };

/** An ISO datetime inside the month the view opens on, so the event lands in a rendered cell. */
const inMonth = (day: number, hour = 9, minute = 0) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), day, hour, minute).toISOString();
};

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  routineId: 'r-1',
  botId: BOT_A.id,
  botName: BOT_A.name,
  title: 'Morning standup',
  start: inMonth(10, 9),
  end: inMonth(10, 9, 30),
  recurrenceRule: null,
  eventType: 'one_time',
  completedAt: null,
  ...over,
});

const ready = async () => {
  await waitFor(() => expect(screen.queryByText('Loading events…')).toBeNull());
};

beforeEach(() => {
  useStore.setState({ bots: [BOT_A, BOT_B], selectedBotId: BOT_A.id });
  vi.mocked(api.calendar).mockReset();
  vi.mocked(api.createRoutine).mockReset();
  vi.mocked(api.calendar).mockResolvedValue({ events: [] });
});

afterEach(cleanup);

describe('CalendarView', () => {
  it('renders the events returned by GET /api/calendar', async () => {
    vi.mocked(api.calendar).mockResolvedValue({ events: [event()] });

    const { container } = render(<CalendarView />);

    expect(await screen.findByText('Morning standup')).toBeTruthy();
    expect(container.querySelectorAll('.cal-pill').length).toBe(1);

    const call = vi.mocked(api.calendar).mock.calls[0];
    expect(call[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(call[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(call[1]).getTime()).toBeGreaterThan(new Date(call[0]).getTime());
  });

  it('switches month → week → day and updates the range label', async () => {
    const { container } = render(<CalendarView />);
    await ready();

    const monthLabel = container.querySelector('.cal-range')?.textContent ?? '';
    expect(monthLabel).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    expect(container.querySelectorAll('.cal-cell').length).toBe(42);

    fireEvent.click(screen.getByRole('radio', { name: 'Week' }));

    await waitFor(() => expect(container.querySelectorAll('.cal-week__col').length).toBe(7));
    const weekLabel = container.querySelector('.cal-range')?.textContent ?? '';
    expect(weekLabel).not.toBe(monthLabel);
    expect(weekLabel).toMatch(/ – /);
    expect(container.querySelectorAll('.cal-cell').length).toBe(0);

    fireEvent.click(screen.getByRole('radio', { name: 'Day' }));

    await waitFor(() => expect(container.querySelectorAll('.cal-day__row').length).toBe(24));
    const dayLabel = container.querySelector('.cal-range')?.textContent ?? '';
    expect(dayLabel).not.toBe(weekLabel);
    expect(dayLabel).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), [A-Z][a-z]+ \d{1,2}, \d{4}$/);

    expect(vi.mocked(api.calendar).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('opens the create modal pre-filled with the clicked day', async () => {
    const { container } = render(<CalendarView />);
    await ready();

    const cell = container.querySelector<HTMLElement>('.cal-cell');
    expect(cell).toBeTruthy();
    const day = cell?.getAttribute('data-date') ?? '';
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    fireEvent.click(cell as HTMLElement);

    const dialog = await screen.findByRole('dialog', { name: 'New Event' });
    const dateInput = within(dialog).getByLabelText('Date and time') as HTMLInputElement;
    expect(dateInput.value.startsWith(day)).toBe(true);
    expect(within(dialog).getByLabelText('Title')).toBeTruthy();
  });

  it('greys out a completed one-time event and badges both event kinds', async () => {
    vi.mocked(api.calendar).mockResolvedValue({
      events: [
        event({ routineId: 'r-done', title: 'Pay rent', completedAt: inMonth(10, 10) }),
        event({ routineId: 'r-open', title: 'Send invoice' }),
        event({ routineId: 'r-rec', title: 'Weekly review', botId: BOT_B.id, botName: BOT_B.name, eventType: 'recurring', recurrenceRule: '0 9 * * 1' }),
      ],
    });

    render(<CalendarView />);
    expect(await screen.findByText('Pay rent')).toBeTruthy();

    const done = screen.getByText('Pay rent').closest('.cal-pill') as HTMLElement;
    expect(done.className).toContain('is-completed');

    const open = screen.getByText('Send invoice').closest('.cal-pill') as HTMLElement;
    expect(open.className).not.toContain('is-completed');

    expect(screen.getAllByLabelText('One-time event').length).toBe(2);
    expect(screen.getAllByLabelText('Recurring event').length).toBe(1);
  });

  it('shows the event popover with the bot and schedule, then closes it', async () => {
    vi.mocked(api.calendar).mockResolvedValue({
      events: [event({ title: 'Weekly report', eventType: 'recurring', recurrenceRule: '0 9 * * 1' })],
    });

    render(<CalendarView />);
    fireEvent.click(await screen.findByText('Weekly report'));

    const pop = await screen.findByRole('dialog', { name: 'Event details' });
    expect(within(pop).getByText('Ada')).toBeTruthy();
    expect(within(pop).getByText('Repeats · 0 9 * * 1')).toBeTruthy();

    fireEvent.click(within(pop).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Event details' })).toBeNull();
  });

  it('shows an inline error with Retry when the fetch fails', async () => {
    vi.mocked(api.calendar).mockRejectedValueOnce(new Error('Calendar unavailable'));

    render(<CalendarView />);

    expect(await screen.findByText('Calendar unavailable')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' });

    vi.mocked(api.calendar).mockResolvedValueOnce({ events: [event()] });
    fireEvent.click(retry);

    expect(await screen.findByText('Morning standup')).toBeTruthy();
    expect(vi.mocked(api.calendar).mock.calls.length).toBe(2);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('validates the create form before calling api.createRoutine', async () => {
    render(<CalendarView />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Event' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create event' }));

    expect(within(dialog).getByText('Give the event a title.')).toBeTruthy();
    expect(within(dialog).getByText('Describe what the bot should do.')).toBeTruthy();
    expect(vi.mocked(api.createRoutine)).not.toHaveBeenCalled();
  });

  it('creates a recurring event and refreshes the calendar', async () => {
    vi.mocked(api.createRoutine).mockResolvedValue({ routine: {} as never });
    render(<CalendarView />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'New event' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Event' });

    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Weekly report' } });
    fireEvent.change(within(dialog).getByLabelText('Assigned bot'), { target: { value: BOT_B.id } });
    fireEvent.change(within(dialog).getByLabelText('Task / prompt'), { target: { value: 'Summarise the week.' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Recurring' }));
    fireEvent.change(within(dialog).getByLabelText('Repeats'), { target: { value: 'weekdays' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create event' }));

    await waitFor(() => expect(vi.mocked(api.createRoutine)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createRoutine).mock.calls[0][0]).toMatchObject({
      botId: BOT_B.id,
      title: 'Weekly report',
      prompt: 'Summarise the week.',
      eventType: 'recurring',
      schedule: '0 9 * * 1-5',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New Event' })).toBeNull());
    expect(vi.mocked(api.calendar).mock.calls.length).toBe(2);
  });
});

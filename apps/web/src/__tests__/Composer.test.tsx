import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, Row } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    send: vi.fn(async () => ({ row: {} })),
    interrupt: vi.fn(async () => ({ ok: true })),
    fresh: vi.fn(async () => ({ ok: true })),
    uploadAttachment: vi.fn(async () => ({ path: 'x', filename: 'x', mediaType: 'text/plain' })),
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
}));

import { api } from '../lib/api';
import { Composer } from '../components/Composer';

/** A complete Bot, so a test only states the fields it cares about. */
function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud' as const, voiceModel: 'piper-lessac-medium',
    model: null, provider: null, initiative: 'proactive', generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

const row = (seq: number, text: string): Row => ({
  botId: 'c1', generation: 1, seq, updatedSeq: 1, kind: 'message', createdAt: 1_000,
  body: { type: 'message', role: 'user', text },
});

/** A promise whose resolution the test controls, to hold a send "in flight". */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(cleanup);

describe('Composer', () => {
  it('offers no Send before there is anything to send, and Enter sends nothing', () => {
    render(<Composer bot={bot({ id: 'c1', name: 'Scout' })} running={false} />);
    const input = screen.getByRole('textbox', { name: 'Message Scout' }) as HTMLTextAreaElement;

    // With an empty box the main button is the voice-call button, not Send.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start voice chat with Scout' })).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.send).not.toHaveBeenCalled();

    // Spaces are not a message either.
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.send).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('sends the trimmed text once when Enter is pressed, then clears the box', async () => {
    render(<Composer bot={bot({ id: 'c2', name: 'Scout' })} running={false} />);
    const input = screen.getByRole('textbox', { name: 'Message Scout' }) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '  Summarise the deck  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith('c2', 'Summarise the deck', undefined);
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    render(<Composer bot={bot({ id: 'c3', name: 'Scout' })} running={false} />);
    const input = screen.getByRole('textbox', { name: 'Message Scout' }) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(api.send).not.toHaveBeenCalled();
    expect(input.value).toBe('line one');

    // The newline the browser would insert is kept, and a plain Enter then sends the lot.
    fireEvent.change(input, { target: { value: 'line one\nline two' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith('c3', 'line one\nline two', undefined);
  });

  it('sends from the Send button once the box has text', async () => {
    render(<Composer bot={bot({ id: 'c4', name: 'Scout' })} running={false} />);
    const input = screen.getByRole('textbox', { name: 'Message Scout' }) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'Draft the release note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith('c4', 'Draft the release note', undefined);
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('blocks a second send while the first one is still going', async () => {
    const d = deferred<{ row: Row }>();
    vi.mocked(api.send).mockImplementationOnce(() => d.promise);
    render(<Composer bot={bot({ id: 'c5', name: 'Scout' })} running={false} />);
    const input = screen.getByRole('textbox', { name: 'Message Scout' }) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'One message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));

    // Still in flight: the button is off and another Enter does nothing.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.send).toHaveBeenCalledTimes(1);

    await act(async () => { d.resolve({ row: row(1, 'One message') }); });
    await waitFor(() => expect(input.value).toBe(''));
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('keeps what was typed and says so when a send fails', async () => {
    vi.mocked(api.send).mockRejectedValueOnce(new Error('Server unreachable'));
    render(<Composer bot={bot({ id: 'c6', name: 'Scout' })} running={false} />);
    const input = screen.getByRole('textbox', { name: 'Message Scout' }) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'Please retry me' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/Server unreachable/)).toBeTruthy());
    expect(input.value).toBe('Please retry me');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Server unreachable/)).toBeNull();
  });

  it('shows Stop instead of Send while the Bot is working, and interrupts when clicked', async () => {
    render(<Composer bot={bot({ id: 'c7', name: 'Scout' })} running={true} />);

    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledTimes(1));
    expect(api.interrupt).toHaveBeenCalledWith('c7');
  });
});

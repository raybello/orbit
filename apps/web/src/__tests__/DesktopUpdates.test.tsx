import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopUpdateStatus } from '@orbit/contracts';
import { UpdatesSection } from '../components/config/AppSettings';

function stubUpdates(initial: DesktopUpdateStatus) {
  let push: (s: DesktopUpdateStatus) => void = () => {};
  const bridge = {
    status: vi.fn(async () => initial),
    check: vi.fn(async () => initial),
    download: vi.fn(async () => initial),
    install: vi.fn(async () => {}),
    onStatus: vi.fn((cb: (s: DesktopUpdateStatus) => void) => { push = cb; return () => {}; }),
    onOpenRequest: vi.fn(() => () => {}),
  };
  vi.stubGlobal('orbitDesktop', { platform: 'darwin', updates: bridge });
  return { bridge, push: (s: DesktopUpdateStatus) => act(() => push(s)) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Settings > Updates', () => {
  it('is absent outside the desktop app', () => {
    const { container } = render(<UpdatesSection />);
    expect(container.textContent).toBe('');
  });

  it('offers a found release, downloads it on request, and restarts only once it is ready', async () => {
    const { bridge, push } = stubUpdates({ phase: 'available', current: '0.3.0', version: '0.4.0' });
    render(<UpdatesSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download update' }));
    await waitFor(() => expect(bridge.download).toHaveBeenCalledTimes(1));

    push({ phase: 'downloading', current: '0.3.0', version: '0.4.0', percent: 42 });
    expect(screen.getByText(/42% · Orbit keeps running/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();

    push({ phase: 'ready', current: '0.3.0', version: '0.4.0' });
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    await waitFor(() => expect(bridge.install).toHaveBeenCalledTimes(1));
  });

  it('a failed check can be retried', async () => {
    const { bridge } = stubUpdates({ phase: 'error', current: '0.3.0', error: 'net::ERR_INTERNET_DISCONNECTED' });
    render(<UpdatesSection />);
    expect(await screen.findByText('net::ERR_INTERNET_DISCONNECTED')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(bridge.check).toHaveBeenCalledTimes(1));
  });
});

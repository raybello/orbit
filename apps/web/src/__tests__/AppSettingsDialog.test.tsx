import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// AppSettings pulls in the store, which pulls in the API client; nothing here talks to a server.
vi.mock('../lib/api', () => ({
  api: {
    bots: vi.fn(async () => ({ bots: [], live: [] })),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
  openPopup: vi.fn(),
}));

import { AppSettings } from '../components/config/AppSettings';
import { useConfigUI } from '../configStore';

const openAt = (section: Parameters<ReturnType<typeof useConfigUI.getState>['openAppSettings']>[0]) =>
  act(() => { useConfigUI.getState().openAppSettings(section); });

describe('Settings dialog', () => {
  beforeEach(() => { useConfigUI.getState().closeAppSettings(); });
  afterEach(() => { cleanup(); useConfigUI.getState().closeAppSettings(); });

  it('is a labelled modal dialog with every section in its nav', () => {
    openAt('appearance');
    render(<AppSettings />);
    const dialog = screen.getByRole('dialog', { name: 'Appearance' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    for (const label of ['General', 'Appearance', 'Engine Auth', 'API keys', 'Computer', 'Devices & permissions', 'Permissions', 'Connected apps', 'Account']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.queryByText(/Back to Bots/)).toBeNull();
  });

  it('deep-links to a section and switches sections from the nav', () => {
    openAt('engine-auth');
    render(<AppSettings />);
    expect(screen.getByRole('heading', { name: 'Engine Auth' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Engine Auth' }).getAttribute('aria-current')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(useConfigUI.getState().appSettings).toBe('appearance');
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy();
  });

  it('closes on Escape', () => {
    openAt('general');
    render(<AppSettings />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useConfigUI.getState().appSettings).toBeNull();
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    openAt('general');
    render(<AppSettings />);
    fireEvent.mouseDown(screen.getByRole('heading', { name: 'General' }));
    expect(useConfigUI.getState().appSettings).toBe('general');
    fireEvent.mouseDown(document.querySelector('.settings-scrim')!);
    expect(useConfigUI.getState().appSettings).toBeNull();
  });

  it('closes from the close button', () => {
    openAt('general');
    render(<AppSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(useConfigUI.getState().appSettings).toBeNull();
  });

  it('moves focus in on open and keeps Tab inside the dialog', () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    outside.focus();

    openAt('general');
    const { unmount } = render(<AppSettings />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'General' }));

    const focusables = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), select, input')];
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Focus outside the dialog is pulled back in.
    outside.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    act(() => { useConfigUI.getState().closeAppSettings(); });
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

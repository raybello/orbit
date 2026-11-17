import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { User } from '@orbit/contracts';

vi.mock('../lib/api', () => ({ api: { logout: vi.fn(async () => ({ ok: true })) } }));

import { TitleBar } from '../components/TitleBar';
import { useStore } from '../store';

const USER: User = { id: 'usr_a', email: 'ada@example.com', name: 'Ada Lovelace', avatarUrl: null };
const base = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...base, user: USER, modal: null });
});

afterEach(cleanup);

/**
 * The title bar is the one row above everything else: the search everybody reaches for, the
 * account, and Connect apps. It replaced the rail's footer, so these are the affordances that
 * must stay reachable from there.
 */
describe('TitleBar', () => {
  it('opens the search from its bar', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Search Orbit' }));
    expect(useStore.getState().modal).toBe('search');
  });

  it('opens Connect apps from the right-hand actions', () => {
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect apps' }));
    expect(useStore.getState().modal).toBe('apps');
  });

  it('shows the account and offers settings and log out', () => {
    render(<TitleBar />);
    // avatar button uses onMouseDown to avoid Electron drag-region click swallowing
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Account menu' }));

    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Settings/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Log out/ })).toBeTruthy();
  });
});

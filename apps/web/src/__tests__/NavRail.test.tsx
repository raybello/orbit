import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NavSection } from '@orbit/contracts';
import { NavRail } from '../components/NavRail';

/** The rail's sections, in the order they must appear. */
const ORDER: [NavSection, string][] = [
  ['activity', 'Activity'],
  ['chat', 'Chat'],
  ['calendar', 'Calendar'],
  ['calls', 'Calls'],
  ['files', 'Files'],
  ['computers', 'Computers'],
  ['skills', 'Skills'],
];

afterEach(cleanup);

describe('NavRail', () => {
  it('renders all seven sections in order with accessible names', () => {
    const { container } = render(<NavRail active="chat" onChange={() => {}} />);

    const items = Array.from(container.querySelectorAll<HTMLElement>('.nav-rail__item'));
    expect(items.map((el) => el.textContent)).toEqual(ORDER.map(([, label]) => label));

    for (const [, label] of ORDER) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('calls onChange with the section that was clicked', () => {
    const onChange = vi.fn();
    render(<NavRail active="chat" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('calendar');
  });

  it('shows an unread badge with the count for a section', () => {
    const { container } = render(<NavRail active="chat" onChange={() => {}} unreadCounts={{ chat: 3 }} />);

    const badge = container.querySelector<HTMLElement>('.nav-rail__badge');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('3');
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('marks the active section as current', () => {
    render(<NavRail active="files" onChange={() => {}} />);

    const active = screen.getByRole('button', { name: 'Files' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.className).toContain('is-active');

    const inactive = screen.getByRole('button', { name: 'Calls' });
    expect(inactive.getAttribute('aria-current')).toBeNull();
    expect(inactive.className).not.toContain('is-active');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';

// Every view fetches on mount; an empty answer of every shape keeps them on their empty states.
vi.mock('../lib/api', () => {
  const empty = { events: [], files: [], total: 0, computers: [], skills: [] };
  return { api: { calendar: vi.fn(async () => empty), files: vi.fn(async () => empty), computers: vi.fn(async () => empty), skills: vi.fn(async () => empty), fileUrl: () => '' } };
});

import { ActivityView } from '../components/ActivityView';
import { CalendarView } from '../components/CalendarView';
import { CallsView } from '../components/CallsView';
import { ComputersView } from '../components/ComputersView';
import { FilesView } from '../components/FilesView';
import { SkillsView } from '../components/SkillsView';

afterEach(cleanup);

const PAGES: [string, ComponentType][] = [
  ['Activity', ActivityView],
  ['Calendar', CalendarView],
  ['Calls', CallsView],
  ['Files', FilesView],
  ['Screens', ComputersView],
  ['Skills', SkillsView],
];

/** Every rail section's main view sits in the one page frame: a single titled header and a body. */
describe('top-level pages share the page shell', () => {
  it.each(PAGES)('%s has one page header carrying its title', (title, View) => {
    const { container } = render(<View />);

    const heading = screen.getByRole('heading', { level: 1, name: title });
    expect(heading.closest('.page__header')).toBeTruthy();
    expect(container.querySelectorAll('.page__header')).toHaveLength(1);
    expect(container.querySelector('.page > .page__body')).toBeTruthy();
  });

  it("a chat's Files tab has no page header of its own", () => {
    const { container } = render(<FilesView botId="bot_a" />);

    expect(container.querySelector('.page__header')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Search files' })).toBeTruthy();
  });
});

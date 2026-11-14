import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, FileEntry, FilesResponse } from '@orbit/contracts';
import { api } from '../lib/api';
import { useStore } from '../store';
import { FilesView } from '../components/FilesView';

/**
 * Only the files endpoint is replaced: `fileUrl` and friends stay real so the component renders
 * the same URLs the server serves.
 */
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, files: vi.fn() } };
});

const filesMock = vi.mocked(api.files);

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  label: '',
  description: '',
  instructions: '',
  avatarShape: 'blob',
  avatarColor: 'blue',
  mode: 'personal',
  isPrimary: false,
  pinned: false,
  effort: 'medium',
  voice: 'default',
  voiceSpeed: 1,
  voiceLanguage: 'auto',
  model: null,
  provider: null,
  generation: 0,
  unread: 0,
  lastPreview: null,
  lastActivityAt: 0,
  createdAt: 0,
});

const file = (over: Partial<FileEntry> = {}): FileEntry => ({
  id: 'f1',
  botId: 'b1',
  botName: 'Quinn',
  type: 'library',
  filename: 'report.pdf',
  path: 'reports/report.pdf',
  size: 12_288,
  mediaType: 'application/pdf',
  createdAt: Date.UTC(2026, 10, 12, 15, 0),
  downloadUrl: '/api/files/f1/download',
  ...over,
});

const page = (files: FileEntry[], total = files.length): FilesResponse => ({ files, total, page: 1, pageSize: 50 });

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ bots: [bot('b1', 'Quinn'), bot('b2', 'Vera')] });
  filesMock.mockReset();
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FilesView', () => {
  it('renders the files the api returns with bot, size and date', async () => {
    filesMock.mockResolvedValue(page([
      file(),
      file({ id: 'f2', filename: 'notes.md', path: 'notes.md', mediaType: 'text/markdown', size: 2048, type: 'attachment' }),
    ]));

    const { container } = render(<FilesView />);

    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('notes.md')).toBeTruthy();
    const owners = Array.from(container.querySelectorAll<HTMLElement>('.file-item__bot-name'));
    expect(owners.map((el) => el.textContent)).toEqual(['Quinn', 'Quinn']);
    expect(screen.getAllByText(/12 KB/)).toHaveLength(1);
    expect(filesMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'all', page: 1, pageSize: 50 }));
  });

  it('refetches with type=library when a type tab is picked and replaces the list', async () => {
    filesMock
      .mockResolvedValueOnce(page([file()]))
      .mockResolvedValueOnce(page([file({ id: 'f3', filename: 'saved-notes.txt', path: 'saved-notes.txt', mediaType: 'text/plain', size: 512 })]));

    render(<FilesView />);
    expect(await screen.findByText('report.pdf')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Library' }));

    expect(await screen.findByText('saved-notes.txt')).toBeTruthy();
    expect(screen.queryByText('report.pdf')).toBeNull();
    expect(filesMock).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'library', page: 1 }));
  });

  it('sends the search term to the api once typing settles', async () => {
    filesMock.mockResolvedValue(page([file()]));

    render(<FilesView />);
    await screen.findByText('report.pdf');
    const before = filesMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Search files'), { target: { value: 'budget' } });
    expect(filesMock.mock.calls.length).toBe(before);

    await waitFor(() => expect(filesMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'budget', page: 1 })));
  });

  it('filters by bot', async () => {
    filesMock.mockResolvedValue(page([file()]));

    render(<FilesView />);
    await screen.findByText('report.pdf');

    fireEvent.change(screen.getByLabelText('Filter by bot'), { target: { value: 'b2' } });

    await waitFor(() => expect(filesMock).toHaveBeenLastCalledWith(expect.objectContaining({ botId: 'b2', page: 1 })));
  });

  it('shows the empty state when there are no files', async () => {
    filesMock.mockResolvedValue(page([]));

    render(<FilesView />);

    expect(await screen.findByText('No files yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows an error with Retry and loads the list when retried', async () => {
    filesMock.mockRejectedValueOnce(new Error('Server exploded')).mockResolvedValueOnce(page([file()]));

    render(<FilesView />);

    expect(await screen.findByText(/Couldn’t load files/)).toBeTruthy();
    expect(screen.getByText('Server exploded')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(filesMock).toHaveBeenCalledTimes(2);
  });

  it('appends the next page and marks the end of the list', async () => {
    filesMock
      .mockResolvedValueOnce({ files: [file()], total: 2, page: 1, pageSize: 50 })
      .mockResolvedValueOnce({ files: [file({ id: 'f2', filename: 'notes.md', path: 'notes.md' })], total: 2, page: 2, pageSize: 50 });

    render(<FilesView />);
    expect(await screen.findByText('report.pdf')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('notes.md')).toBeTruthy();
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText(/End of list/)).toBeTruthy();
    expect(filesMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 50 }));
  });

  it('remembers the grid or list choice across mounts', async () => {
    filesMock.mockResolvedValue(page([file()]));

    const first = render(<FilesView />);
    await screen.findByText('report.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));

    expect(localStorage.getItem('grokbot.filesView')).toBe('list');
    expect(screen.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed')).toBe('true');
    first.unmount();

    render(<FilesView />);
    expect(screen.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens an image in the viewer', async () => {
    filesMock.mockResolvedValue(page([file({ id: 'i1', filename: 'shot.png', path: 'shot.png', mediaType: 'image/png' })]));

    render(<FilesView />);

    fireEvent.click(await screen.findByText('shot.png'));

    expect(await screen.findByRole('dialog', { name: 'shot.png' })).toBeTruthy();
  });

  it('previews text files in a modal instead of downloading them', async () => {
    filesMock.mockResolvedValue(page([file({ id: 't1', filename: 'notes.txt', path: 'notes.txt', mediaType: 'text/plain', size: 64 })]));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => '# Standup notes\nAll good.' });
    vi.stubGlobal('fetch', fetchMock);

    render(<FilesView />);

    fireEvent.click(await screen.findByText('notes.txt'));

    expect(await screen.findByRole('dialog', { name: 'Preview of notes.txt' })).toBeTruthy();
    expect(await screen.findByText(/Standup notes/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/files/t1/download', { credentials: 'include' });
  });
});

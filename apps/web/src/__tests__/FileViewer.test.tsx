import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, DataListing } from '@orbit/contracts';
import { viewerFor } from '@orbit/domain';

vi.mock('../lib/configApi', () => ({
  configApi: { dataFiles: vi.fn() },
  dataFileUrl: (p: string) => `/api/data/raw?path=${encodeURIComponent(p)}`,
}));

import { configApi } from '../lib/configApi';
import { FileViewer } from '../components/files/FileViewer';
import { LibraryTab, resolveDataHref } from '../components/config/LibraryTab';

const dataFiles = vi.mocked(configApi.dataFiles);
const bytes = (t: string) => new TextEncoder().encode(t).buffer;
const serve = (body: ArrayBuffer, ok = true, status = 200, json?: unknown) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, status, statusText: ok ? 'OK' : 'Forbidden', arrayBuffer: async () => body, json: async () => json }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('which viewer opens a file', () => {
  it('Markdown renders, images view, media and archives download, the rest is text', () => {
    expect(viewerFor('US_Military_Capabilities_Report_2025.md')).toBe('markdown');
    expect(viewerFor('notes.MARKDOWN')).toBe('markdown');
    expect(viewerFor('chart.png')).toBe('image');
    expect(viewerFor('logo.svg')).toBe('image');
    for (const n of ['call.mp3', 'clip.mp4', 'paper.pdf', 'site.zip', 'orbit.db', 'model.gguf']) expect(viewerFor(n), n).toBe('other');
    for (const n of ['main.py', 'config.yaml', 'Dockerfile', 'LICENSE', 'gateway.out.log', 'data.json']) expect(viewerFor(n), n).toBe('text');
    expect(viewerFor('blob', 'image/webp')).toBe('image');
  });
});

describe("a Markdown file's links", () => {
  const root = '/data';
  it('point into the data folder, from the file\'s own folder or by an absolute /data path', () => {
    const dir = 'engines/primary/workspace';
    expect(resolveDataHref('chart.png', dir, root)).toBe('/api/data/raw?path=engines%2Fprimary%2Fworkspace%2Fchart.png');
    expect(resolveDataHref('../notes/a b.md', dir, root)).toBe('/api/data/raw?path=engines%2Fprimary%2Fnotes%2Fa%20b.md');
    expect(resolveDataHref('/data/files/x.txt', dir, root)).toBe('/api/data/raw?path=files%2Fx.txt');
  });
  it('are left alone when they are web addresses, anchors, or outside the folder', () => {
    for (const h of ['https://example.com/a.png', '#top', 'mailto:a@b.c', '/etc/passwd', '../../../../x', '//cdn.example.com/a.js']) {
      expect(resolveDataHref(h, 'engines/primary/workspace', root), h).toBe(h);
    }
  });
});

describe('the file viewer', () => {
  it('says a binary file is binary instead of printing it', async () => {
    serve(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]).buffer);
    render(<FileViewer file={{ name: 'agent', url: '/x' }} onClose={() => {}} />);
    expect(await screen.findByText(/This is a binary file/)).toBeTruthy();
  });
  it("shows the server's reason when a file is refused", async () => {
    serve(bytes(''), false, 403, { error: 'This file holds credentials, so it is not shown here. Edit API keys under Settings → API keys.' });
    render(<FileViewer file={{ name: '.env', url: '/x' }} onClose={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t open this file. This file holds credentials, so it is not shown here. Edit API keys under Settings → API keys.');
  });
  it('does not load a file too big to view', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<FileViewer file={{ name: 'huge.log', url: '/x', size: 50_000_000 }} onClose={() => {}} />);
    expect(await screen.findByText(/too big to preview/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("renders a Markdown file's relative image from beside it", async () => {
    serve(bytes('# Report\n\n![chart](chart.png)'));
    render(<FileViewer file={{ name: 'r.md', url: '/x', resolve: (h) => resolveDataHref(h, 'engines/primary/workspace', '/data') }} onClose={() => {}} />);
    const img = await screen.findByRole('img', { name: 'chart' });
    expect(img.getAttribute('src')).toBe('/api/data/raw?path=engines%2Fprimary%2Fworkspace%2Fchart.png');
  });
  it('opens an image in the image viewer', () => {
    render(<FileViewer file={{ name: 'shot.png', url: '/api/data/raw?path=shot.png' }} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'shot.png' })).toBeTruthy();
  });
});

describe('the Library panel', () => {
  const bot = { id: 'bot_atlas', name: 'Atlas' } as Bot;
  const at = (path: string, files: DataListing['files']): DataListing => ({ root: '/data', path, workspace: 'engines/primary/workspace', files });

  it("opens at the Bot's workspace, walks up to the data folder, and opens a report rendered", async () => {
    dataFiles.mockImplementation(async (o) => (o.path === undefined || o.path === 'engines/primary/workspace'
      ? at('engines/primary/workspace', [{ name: 'US_Military_Capabilities_Report_2025.md', size: 120, modifiedAt: Date.now(), isDir: false }])
      : at(o.path, [{ name: 'engines', size: 0, modifiedAt: Date.now(), isDir: true }, { name: 'computers', size: 0, modifiedAt: Date.now(), isDir: true }])));
    render(<LibraryTab bot={bot} />);

    expect(await screen.findByText('US_Military_Capabilities_Report_2025.md')).toBeTruthy();
    expect(dataFiles).toHaveBeenCalledWith({ botId: 'bot_atlas' });
    expect(screen.getByText('/data/engines/primary/workspace')).toBeTruthy();

    serve(bytes('# US military capabilities\n\nPersonnel, budget, forces.'));
    fireEvent.click(screen.getByRole('button', { name: /US_Military_Capabilities_Report_2025\.md/ }));
    expect(await screen.findByRole('heading', { name: 'US military capabilities' })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/data/raw?path=engines%2Fprimary%2Fworkspace%2FUS_Military_Capabilities_Report_2025.md', { credentials: 'include' });
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));

    fireEvent.click(screen.getByRole('button', { name: 'data' }));
    await waitFor(() => expect(dataFiles).toHaveBeenLastCalledWith({ path: '', botId: 'bot_atlas' }));
    expect(await screen.findByText('computers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    await waitFor(() => expect(dataFiles).toHaveBeenLastCalledWith({ path: 'engines/primary/workspace', botId: 'bot_atlas' }));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Bot, Row } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    rows: vi.fn(async () => ({ generation: 1, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
    bots: vi.fn(async () => ({ bots: [], live: [] })),
  },
}));
vi.mock('../lib/configApi', () => ({ configApi: {} }));

import fs from 'node:fs';
import { DetailsPanel } from '../components/DetailsPanel';
import { ARTIFACT_SANDBOX } from '../components/ArtifactFrame';
import { ArtifactCard } from '../components/cards/ArtifactCard';
import { useStore } from '../store';

const SCOUT: Bot = {
  id: 'a', name: 'Scout', label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
  mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
  voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud', voiceModel: 'piper-lessac-medium',
  model: null, provider: null, initiative: 'proactive', generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
};

const ID = 'art_timer0001';
const art = (seq: number, title: string, html: string): Row => ({
  botId: 'a', generation: 1, seq, updatedSeq: seq, kind: 'tool-call', createdAt: seq * 1000,
  body: { type: 'tool-call', callId: `c${seq}`, name: 'artifact', label: 'Building an artifact', status: 'done', args: { artifactId: ID, title, html } },
});
const V1 = '<!doctype html><p>blue timer</p>';
const V2 = '<!doctype html><p>red timer</p>';
const base = useStore.getState();

function withRows(rows: Row[]) {
  useStore.setState({
    ...base, bots: [SCOUT], selectedBotId: 'a', detailsOpen: true, detailsTab: 'screen', openArtifacts: {},
    transcripts: { a: { generation: 1, loaded: true, bySeq: Object.fromEntries(rows.map((r) => [r.seq, r])) } },
  });
}

const frame = () => document.querySelector('iframe.artifact-frame') as HTMLIFrameElement;
const tabNames = (container: HTMLElement) => [...container.querySelectorAll('.details-tab')].map((t) => t.textContent);

beforeEach(() => withRows([art(2, 'Timer', V1), art(5, 'Timer', V2)]));
afterEach(cleanup);

describe('artifact tab', () => {
  it('stays out of the tab bar until the chat has an artifact', () => {
    withRows([]);
    const { container } = render(<DetailsPanel />);
    expect(tabNames(container)).toEqual(['Screen', 'Activity', 'Tasks', 'Library', 'Engine']);
  });

  it('opens on the latest version from the chat card, in a frame with no access to Orbit', () => {
    const { container } = render(<><ArtifactCard botId="a" seq={5} artifact={{ artifactId: ID as never, title: 'Timer', html: V2 }} version={{ n: 2, of: 2 }} /><DetailsPanel /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Open Timer' }));

    expect(tabNames(container)[0]).toBe('Artifact');
    expect(screen.getByRole('tab', { name: 'Artifact' }).getAttribute('aria-selected')).toBe('true');
    expect(frame().getAttribute('srcdoc')).toBe(V2);
    const sandbox = frame().getAttribute('sandbox')!.split(' ');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-popups');
    expect(screen.getByRole('button', { name: 'Open Timer' }).textContent).toBe('Showing');
  });

  it('switches the frame to an older version and back', () => {
    useStore.getState().openArtifact('a', { artifactId: ID as never, seq: null });
    render(<DetailsPanel />);
    const picker = screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement;
    expect(picker.selectedOptions[0].textContent).toBe('v2 of 2 (latest)');

    fireEvent.change(picker, { target: { value: '0' } });
    expect(frame().getAttribute('srcdoc')).toBe(V1);
    expect(useStore.getState().openArtifacts.a).toEqual({ artifactId: ID, seq: 2 });

    fireEvent.change(picker, { target: { value: '1' } });
    expect(frame().getAttribute('srcdoc')).toBe(V2);
    expect(useStore.getState().openArtifacts.a.seq).toBeNull();
  });

  it('shows the exact source', () => {
    useStore.getState().openArtifact('a', { artifactId: ID as never, seq: null });
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByLabelText('Artifact HTML source').textContent).toBe(V2);
    expect(frame()).toBeNull();
  });

  it('follows a new version when it lands, unless an older one is pinned', () => {
    useStore.getState().openArtifact('a', { artifactId: ID as never, seq: null });
    render(<DetailsPanel />);
    const v3 = '<!doctype html><p>green timer</p>';
    act(() => useStore.getState().upsertRows('a', 1, [art(8, 'Timer', v3)]));
    expect(frame().getAttribute('srcdoc')).toBe(v3);

    act(() => useStore.getState().openArtifact('a', { artifactId: ID as never, seq: 2 }));
    act(() => useStore.getState().upsertRows('a', 1, [art(11, 'Timer', '<p>v4</p>')]));
    expect(frame().getAttribute('srcdoc')).toBe(V1);
  });
});

describe('expanded artifact', () => {
  beforeEach(() => useStore.getState().openArtifact('a', { artifactId: ID as never, seq: null }));

  it('expands and collapses from the panel, and Escape collapses it', () => {
    const { container } = render(<DetailsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand artifact' }));
    expect(useStore.getState().artifactExpanded).toBe(true);
    expect(container.querySelector('.details')!.classList.contains('is-expanded')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse artifact' }));
    expect(useStore.getState().artifactExpanded).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Expand artifact' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useStore.getState().artifactExpanded).toBe(false);
    expect(container.querySelector('.details')!.classList.contains('is-wide')).toBe(true);
  });

  it('ends when the panel closes, the tab changes or the chat changes', () => {
    const st = () => useStore.getState();
    act(() => st().set({ artifactExpanded: true }));
    act(() => st().set({ detailsOpen: false }));
    expect(st().artifactExpanded).toBe(false);

    act(() => st().openArtifact('a', { artifactId: ID as never, seq: null }));
    act(() => st().set({ artifactExpanded: true }));
    act(() => st().set({ detailsTab: 'screen' }));
    expect(st().artifactExpanded).toBe(false);

    act(() => st().set({ detailsTab: 'artifact', artifactExpanded: true }));
    act(() => st().selectBot('other'));
    expect(st().artifactExpanded).toBe(false);
  });

  it('opens a new window and sends the artifact only to that window, once it says it is ready', () => {
    const posted: unknown[] = [];
    const child = { postMessage: (data: unknown, origin: string) => posted.push({ data, origin }) };
    const open = vi.spyOn(window, 'open').mockReturnValue(child as unknown as Window);
    render(<DetailsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Open in new window' }));
    expect(open).toHaveBeenCalledWith('/artifact-window.html', '_blank', expect.any(String));

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'artifact-window-ready' }, origin: 'https://evil.example', source: child as never }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'artifact-window-ready' }, origin: location.origin, source: window }));
    expect(posted).toEqual([]);

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'artifact-window-ready' }, origin: location.origin, source: child as never }));
    expect(posted).toEqual([{ data: { type: 'artifact', html: V2, title: 'Timer' }, origin: location.origin }]);
    open.mockRestore();
  });

  it('frames the new window with the same sandbox as the app', () => {
    const page = fs.readFileSync('public/artifact-window.js', 'utf8');
    expect(page).toContain(`var SANDBOX = '${ARTIFACT_SANDBOX}';`);
  });
});

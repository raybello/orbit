import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('../components/files/CodeView', () => ({ default: ({ text }: { text: string }) => <pre aria-label="Whole file">{text}</pre> }));

import { DetailsPanel } from '../components/DetailsPanel';
import { useStore } from '../store';

const SCOUT: Bot = {
  id: 'a', name: 'Scout', label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
  mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
  voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud', voiceModel: 'piper-lessac-medium',
  model: null, provider: null, initiative: 'proactive', generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
};
const call = (seq: number, name: string, args: unknown): Row => ({
  botId: 'a', generation: 1, seq, updatedSeq: seq, kind: 'tool-call', createdAt: seq,
  body: { type: 'tool-call', callId: `c${seq}`, name, label: '', status: 'done', args },
});
const base = useStore.getState();
const withRows = (rows: Row[]) => useStore.setState({
  ...base, bots: [SCOUT], selectedBotId: 'a', detailsOpen: true, detailsTab: 'code', openArtifacts: {},
  transcripts: { a: { generation: 1, loaded: true, bySeq: Object.fromEntries(rows.map((r) => [r.seq, r])) } },
});
const tabNames = (c: HTMLElement) => [...c.querySelectorAll('.details-tab')].map((t) => t.textContent);

beforeEach(() => withRows([
  call(1, 'write_file', { path: 'scratch/fizz.py', content: 'if i % 5 == 0:\n    out += "Buzz"\nprint(out)\n' }),
  call(2, 'patch', { path: 'scratch/fizz.py', old_string: '    out += "Buzz"', new_string: '    out += "Buzz"\nif i % 7 == 0:\n    out += "Bazz"' }),
  call(3, 'patch', { path: 'notes.md', old_string: 'a', new_string: 'b' }),
]));
afterEach(cleanup);

describe('code tab', () => {
  it('stays out of the tab bar until the Bot has changed a file', () => {
    withRows([call(1, 'terminal', { command: 'ls' })]);
    const { container } = render(<DetailsPanel />);
    expect(tabNames(container)).toEqual(['Screen', 'Activity', 'Tasks', 'Library', 'Engine']);
  });

  it('lists each file and opens on the last one changed, with its edits as diffs', () => {
    const { container } = render(<DetailsPanel />);
    expect(tabNames(container)[0]).toBe('Code');
    expect(screen.getAllByRole('button', { name: /edits?$/ }).map((b) => b.textContent)).toEqual(['scratch/fizz.py2 edits', 'notes.md1 edit']);
    expect(screen.getByRole('button', { name: 'notes.md1 edit' }).getAttribute('aria-current')).toBe('true');
    expect([...container.querySelectorAll('.code-diff__line.is-del')].map((l) => l.textContent)).toEqual(['-a']);
    expect([...container.querySelectorAll('.code-diff__line.is-add')].map((l) => l.textContent)).toEqual(['+b']);
  });

  it('shows the whole file once every edit replays, and refuses to guess when one does not', async () => {
    render(<DetailsPanel />);
    expect((screen.getByRole('button', { name: 'File' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'scratch/fizz.py2 edits' }));
    expect(screen.getAllByRole('region').map((r) => r.querySelector('.code-edit__head')!.textContent)).toEqual(['1. Created the file', '2. Edited']);
    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    await waitFor(() => expect(screen.getByLabelText('Whole file').textContent).toBe('if i % 5 == 0:\n    out += "Buzz"\nif i % 7 == 0:\n    out += "Bazz"\nprint(out)\n'));
  });
});

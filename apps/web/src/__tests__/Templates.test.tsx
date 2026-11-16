import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Bot, BotTemplate, BotTemplateSummary, ShareTemplateResponse } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    roomMembers: vi.fn(async () => ({ members: [] })),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
vi.mock('../lib/configApi', () => ({ configApi: { syncEngineAuth: vi.fn(async () => ({ synced: 0 })) } }));
vi.mock('../lib/templatesApi', () => ({
  templatesApi: { gallery: vi.fn(), get: vi.fn(), install: vi.fn(), share: vi.fn(), unshare: vi.fn(), duplicate: vi.fn() },
}));

import { templatesApi } from '../lib/templatesApi';
import { ChatListView } from '../components/ChatListView';
import { TemplatesLayer } from '../components/TemplatesLayer';
import { useStore } from '../store';
import { useTemplatesUI } from '../templatesStore';

const mocked = vi.mocked(templatesApi);

function summary(over: Partial<BotTemplateSummary> & Pick<BotTemplateSummary, 'id' | 'title'>): BotTemplateSummary {
  return {
    slug: null, label: '', description: '', category: 'Productivity', avatarShape: 'blob', avatarColor: 'blue',
    visibility: 'public', origin: 'starter', suggestedApps: [], cadence: 'On demand', installCount: 0, ownerName: null,
    createdAt: 0, updatedAt: 0, ...over,
  };
}

const GALLERY = [
  summary({ id: 'tpl_morning-briefing', title: 'Morning Briefing', label: 'Daily digest', cadence: 'Weekdays at 8:00 AM' }),
  summary({ id: 'tpl_inbox-manager', title: 'Inbox Manager', label: 'Email triage', suggestedApps: ['gmail'] }),
  summary({ id: 'tpl_bug-reproducer', title: 'Bug Reproducer', category: 'Engineering' }),
];

const DETAIL: BotTemplate = {
  ...GALLERY[1]!, instructions: 'Triage every new email.', mode: 'personal',
  skills: [{ name: 'Triage rules', description: '', body: 'Urgent first.' }],
  routines: [{ kind: 'event', name: 'New email', prompt: 'Triage it.', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', config: {} }],
};

function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: '', voiceSpeed: 1, voiceLanguage: 'auto', voiceProvider: 'cloud', voiceModel: 'piper-lessac-medium', model: null, provider: null,
    generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

const titles = () => screen.queryAllByRole('button').map((b) => b.querySelector('.template-card__title')?.textContent).filter(Boolean);
const base = useStore.getState();

beforeEach(() => {
  useStore.setState({ ...base, bots: [bot({ id: 'b-primary', name: 'Orbit', isPrimary: true })], selectedBotId: 'b-primary', transcripts: {}, routines: {} });
  useTemplatesUI.setState({ view: null });
  mocked.gallery.mockResolvedValue({ templates: GALLERY, categories: ['Engineering', 'Productivity'] });
  mocked.get.mockResolvedValue({ template: DETAIL });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('template gallery', () => {
  it('searches and filters by category', async () => {
    useTemplatesUI.getState().open({ kind: 'gallery' });
    render(<TemplatesLayer />);
    await waitFor(() => expect(titles()).toEqual(['Morning Briefing', 'Inbox Manager', 'Bug Reproducer']));

    fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: 'gmail' } });
    expect(titles()).toEqual(['Inbox Manager']);

    fireEvent.change(screen.getByLabelText('Search templates'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Engineering' }));
    expect(titles()).toEqual(['Bug Reproducer']);
  });

  it('opens a template and installs it as a new Bot that becomes the open chat', async () => {
    const installed = bot({ id: 'b-inbox', name: 'Inbox Manager' });
    mocked.install.mockResolvedValue({ bot: installed });
    useTemplatesUI.getState().open({ kind: 'gallery' });
    render(<TemplatesLayer />);

    fireEvent.click(await screen.findByText('Inbox Manager'));
    expect(await screen.findByText('Triage every new email.')).toBeTruthy();
    expect(screen.getByText(/start paused/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(useStore.getState().selectedBotId).toBe('b-inbox'));
    expect(mocked.install).toHaveBeenCalledWith('tpl_inbox-manager');
    expect(useStore.getState().bots.map((b) => b.id)).toContain('b-inbox');
    expect(useTemplatesUI.getState().view).toBeNull();
  });
});

describe('share as template', () => {
  const shared = (visibility: 'link' | 'public'): ShareTemplateResponse => ({
    template: { ...DETAIL, id: 'tpl_abc', visibility, origin: 'user' },
    shareUrl: 'http://orbit.test/?template=tpl_abc',
  });

  it('creates the link on open, publishes on request and can stop sharing', async () => {
    mocked.share.mockImplementation(async (_botId, visibility) => shared(visibility ?? 'link'));
    mocked.unshare.mockResolvedValue({ ok: true });
    useTemplatesUI.getState().open({ kind: 'share', botId: 'b-primary' });
    render(<TemplatesLayer />);

    await waitFor(() => expect((screen.getByLabelText('Template link') as HTMLInputElement).value).toBe('http://orbit.test/?template=tpl_abc'));
    expect(mocked.share).toHaveBeenCalledWith('b-primary');

    fireEvent.click(screen.getByRole('checkbox', { name: /public template gallery/ }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: /public template gallery/ }) as HTMLInputElement).checked).toBe(true));
    expect(mocked.share).toHaveBeenLastCalledWith('b-primary', 'public');

    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(useTemplatesUI.getState().view).toBeNull());
    expect(mocked.unshare).toHaveBeenCalledWith('tpl_abc');
  });
});

describe('explore templates call to action', () => {
  it('shows while the team is only the primary Bot, and goes once there is another', () => {
    const { unmount } = render(<ChatListView />);
    fireEvent.click(screen.getByRole('button', { name: /Explore templates/ }));
    expect(useTemplatesUI.getState().view).toEqual({ kind: 'gallery' });
    unmount();

    useStore.setState({ bots: [...useStore.getState().bots, bot({ id: 'b-2', name: 'Scout' })] });
    render(<ChatListView />);
    expect(screen.queryByRole('button', { name: /Explore templates/ })).toBeNull();
  });
});

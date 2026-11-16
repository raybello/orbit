import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bot, VoiceLocalStatus, VoiceModelItem } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    bots: vi.fn(async () => ({ bots: [], live: [] })),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
}));

import { VoiceSetupModal } from '../components/voice/VoiceSetupModal';
import { VoiceModelsModal } from '../components/voice/VoiceModelsModal';
import { VoiceCallBar } from '../components/VoiceCallBar';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { startCall, useVoice } from '../voice/call';
import { __resetVoiceModelsForTests } from '../voice/models-store';

function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto',
    voiceProvider: 'local', voiceModel: 'piper-lessac-medium',
    model: null, provider: null,
    generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

const SCOUT = bot({ id: 'bot-1', name: 'Scout' });
const ARCHIVIST = bot({ id: 'bot-2', name: 'Archivist', voiceProvider: 'cloud' });

const MB = 1_000_000;
function model(id: string, kind: VoiceModelItem['kind'], state: VoiceModelItem['state'], size: number, over: Partial<VoiceModelItem> = {}): VoiceModelItem {
  const names: Record<string, string> = {
    'zipformer-bilingual-int8': 'Zipformer bilingual', 'silero-vad': 'Silero VAD',
    'piper-lessac-medium': 'Piper lessac-medium', 'kokoro-multi-lang': 'Kokoro multi-lang',
  };
  return {
    id, kind, name: names[id], rate: 16000, size, state, tier: kind === 'tts' ? 'optional' : 'required', note: `${names[id]} note`,
    onDisk: state === 'ready' ? size : 0, pct: state === 'ready' ? 100 : 0, ...over,
  };
}

const STT = (state: VoiceModelItem['state'] = 'ready', over: Partial<VoiceModelItem> = {}) => model('zipformer-bilingual-int8', 'stt', state, 198 * MB, over);
const VAD = (state: VoiceModelItem['state'] = 'ready', over: Partial<VoiceModelItem> = {}) => model('silero-vad', 'vad', state, 0.64 * MB, over);
const PIPER = (state: VoiceModelItem['state'] = 'missing', over: Partial<VoiceModelItem> = {}) => model('piper-lessac-medium', 'tts', state, 64.1 * MB, over);
const KOKORO = (state: VoiceModelItem['state'] = 'missing', over: Partial<VoiceModelItem> = {}) => model('kokoro-multi-lang', 'tts', state, 360.6 * MB, over);

function status(voices: VoiceModelItem[], addon = true): VoiceLocalStatus {
  return {
    available: false,
    runtime: { platform: 'darwin', arch: 'arm64', provider: 'cpu', addon },
    models: { stt: 'ready', tts: 'missing', vad: 'ready' },
    bytes: { total: 199 * MB, have: 199 * MB },
    download: { active: voices.some((m) => m.state === 'downloading'), pct: 0, name: null },
    voices,
  };
}

function reply(body: unknown, code = 200) {
  return { ok: code < 300, status: code, statusText: String(code), headers: { get: () => null }, json: async () => body } as unknown as Response;
}

interface Sent { url: string; method: string; body: unknown }

/** The on-device routes, over a mutable inventory the test advances. */
function stubServer(initial: VoiceModelItem[], opts: { addon?: boolean } = {}) {
  let voices = initial;
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method, body });
    if (url === '/api/voice/local/status') return reply(status(voices, opts.addon ?? true));
    if (url === '/api/voice/local/models/download') return reply({ started: true, model: body.model, startedModels: [body.model], state: {}, states: {} });
    if (url === '/api/voice/local/models/cancel') return reply({ cancelled: true, items: voices });
    if (url.startsWith('/api/voice/local/models/') && method === 'DELETE') return reply({ removed: 1, bytes: 1, items: voices });
    if (url.startsWith('/api/bots/') && method === 'PATCH') {
      const id = url.split('/')[3];
      return reply({ bot: { ...useStore.getState().bots.find((b) => b.id === id), ...body } });
    }
    return reply({ error: 'unexpected' }, 404);
  }));
  return {
    sent,
    calls: (url: string, method?: string) => sent.filter((s) => s.url === url && (!method || s.method === method)),
    set: (next: VoiceModelItem[]) => { voices = next; },
  };
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom */ }
  useStore.setState({ ...useStore.getState(), bots: [SCOUT, ARCHIVIST], live: {}, transcripts: {}, routines: {} });
  useConfigUI.setState({ voiceModels: false });
});

afterEach(() => {
  cleanup();
  __resetVoiceModelsForTests();
  vi.unstubAllGlobals();
  useVoice.setState({ status: 'idle', botId: null, error: null, blocked: null });
});

const dialog = (name: string) => screen.queryByRole('dialog', { name });
const row = (id: string) => document.querySelector<HTMLElement>(`[data-model-id="${id}"]`)!;

describe('first-run voice chooser', () => {
  it('opens when no voice is installed, listing every voice with its size', async () => {
    stubServer([STT(), VAD(), PIPER(), KOKORO()]);
    render(<VoiceSetupModal />);

    const d = await screen.findByRole('dialog', { name: 'Choose an on-device voice' });
    expect(within(d).getByLabelText('Piper lessac-medium')).toBeTruthy();
    expect(within(d).getByLabelText('Kokoro multi-lang')).toBeTruthy();
    expect(d.textContent).toContain('64.1 MB');
    expect(d.textContent).toContain('361 MB');
  });

  it('shows the automatic speech recognition downloads with their progress', async () => {
    stubServer([STT('downloading', { pct: 42, onDisk: 83 * MB }), VAD('ready'), PIPER(), KOKORO()]);
    render(<VoiceSetupModal />);
    await screen.findByRole('dialog', { name: 'Choose an on-device voice' });

    const stt = screen.getByRole('progressbar', { name: 'Zipformer bilingual download progress' });
    expect(stt.getAttribute('aria-valuenow')).toBe('42');
    expect(row('zipformer-bilingual-int8').textContent).toContain('42%');
    expect(row('silero-vad').textContent).toContain('Ready');
  });

  it('stays closed when a voice is installed, when the engine cannot run, or once dismissed', async () => {
    const server = stubServer([STT(), VAD(), PIPER('ready'), KOKORO()]);
    const { unmount } = render(<VoiceSetupModal />);
    await waitFor(() => expect(server.calls('/api/voice/local/status').length).toBeGreaterThan(0));
    expect(dialog('Choose an on-device voice')).toBeNull();
    unmount();
    __resetVoiceModelsForTests();

    const unsupported = stubServer([STT('missing'), VAD('missing'), PIPER(), KOKORO()], { addon: false });
    const second = render(<VoiceSetupModal />);
    await waitFor(() => expect(unsupported.calls('/api/voice/local/status').length).toBeGreaterThan(0));
    expect(dialog('Choose an on-device voice')).toBeNull();
    second.unmount();
    __resetVoiceModelsForTests();

    localStorage.setItem('orbit.voiceSetup', 'done');
    const seen = stubServer([STT(), VAD(), PIPER(), KOKORO()]);
    render(<VoiceSetupModal />);
    await waitFor(() => expect(seen.calls('/api/voice/local/status').length).toBeGreaterThan(0));
    expect(dialog('Choose an on-device voice')).toBeNull();
  });

  it('Skip closes it for good and changes no bot', async () => {
    const server = stubServer([STT(), VAD(), PIPER(), KOKORO()]);
    const { unmount } = render(<VoiceSetupModal />);
    fireEvent.click(await screen.findByText('Skip for now'));

    expect(dialog('Choose an on-device voice')).toBeNull();
    expect(server.calls('/api/voice/local/models/download')).toHaveLength(0);
    expect(server.sent.filter((s) => s.method === 'PATCH')).toHaveLength(0);

    unmount();
    __resetVoiceModelsForTests();
    render(<VoiceSetupModal />);
    await waitFor(() => expect(server.calls('/api/voice/local/status').length).toBeGreaterThan(1));
    expect(dialog('Choose an on-device voice')).toBeNull();
  });

  it('downloads the picked voice, then makes it every bot’s on-device voice', async () => {
    const server = stubServer([STT(), VAD(), PIPER(), KOKORO()]);
    render(<VoiceSetupModal />);
    await screen.findByRole('dialog', { name: 'Choose an on-device voice' });

    fireEvent.click(screen.getByLabelText('Kokoro multi-lang'));
    server.set([STT(), VAD(), PIPER(), KOKORO('downloading', { pct: 30 })]);
    fireEvent.click(screen.getByText('Download Kokoro multi-lang'));

    await waitFor(() => expect(server.calls('/api/voice/local/models/download')).toHaveLength(1));
    expect(server.calls('/api/voice/local/models/download')[0].body).toEqual({ model: 'kokoro-multi-lang' });
    expect(await screen.findByText('30%')).toBeTruthy();
    expect(server.sent.filter((s) => s.method === 'PATCH')).toHaveLength(0);

    server.set([STT(), VAD(), PIPER(), KOKORO('ready')]);
    expect(await screen.findByRole('dialog', { name: 'On-device voice is ready' }, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(server.sent.filter((s) => s.method === 'PATCH')).toHaveLength(2));
    for (const b of [SCOUT, ARCHIVIST]) {
      expect(server.calls(`/api/bots/${b.id}`, 'PATCH')[0].body).toEqual({ voiceProvider: 'local', voiceModel: 'kokoro-multi-lang' });
      expect(useStore.getState().bots.find((x) => x.id === b.id)).toMatchObject({ voiceProvider: 'local', voiceModel: 'kokoro-multi-lang' });
    }
  });

  it('a failed download leaves every bot as it was', async () => {
    const server = stubServer([STT(), VAD(), PIPER(), KOKORO()]);
    render(<VoiceSetupModal />);
    await screen.findByRole('dialog', { name: 'Choose an on-device voice' });

    server.set([STT(), VAD(), PIPER('error'), KOKORO()]);
    fireEvent.click(screen.getByText('Download Piper lessac-medium'));
    expect(await screen.findByText('Download failed')).toBeTruthy();
    expect(server.sent.filter((s) => s.method === 'PATCH')).toHaveLength(0);
    expect(useStore.getState().bots.find((b) => b.id === ARCHIVIST.id)?.voiceProvider).toBe('cloud');
  });
});

describe('Voice models manager', () => {
  it('shows each model’s state and size on disk, with the actions that state allows', async () => {
    stubServer([
      STT('ready'),
      VAD('error'),
      PIPER('downloading', { pct: 55, onDisk: 35 * MB }),
      KOKORO('missing', { onDisk: 12 * MB }),
    ]);
    render(<VoiceModelsModal />);
    await screen.findByText('Zipformer bilingual');

    const stt = within(row('zipformer-bilingual-int8'));
    expect(row('zipformer-bilingual-int8').textContent).toContain('Installed · 198 MB on disk');
    expect(stt.getByText('Redownload')).toBeTruthy();
    expect(stt.getByText('Delete')).toBeTruthy();
    expect(stt.queryByText('Download')).toBeNull();

    const piper = within(row('piper-lessac-medium'));
    expect(row('piper-lessac-medium').textContent).toContain('Downloading 55%');
    expect(piper.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('55');
    expect(piper.getByText('Cancel')).toBeTruthy();
    expect(piper.queryByText('Delete')).toBeNull();

    const kokoro = within(row('kokoro-multi-lang'));
    expect(row('kokoro-multi-lang').textContent).toContain('Partly downloaded · 12 MB of 361 MB');
    expect(kokoro.getByText('Resume')).toBeTruthy();
    expect(kokoro.getByText('Delete')).toBeTruthy();

    const vad = within(row('silero-vad'));
    expect(row('silero-vad').textContent).toContain('Download failed');
    expect(vad.getByText('Retry')).toBeTruthy();

    expect(screen.getByText('245 MB on disk')).toBeTruthy();
  });

  it('cancel, delete and redownload reach the server for that model', async () => {
    const server = stubServer([STT('ready'), VAD('ready'), PIPER('downloading', { pct: 10 }), KOKORO('ready')]);
    render(<VoiceModelsModal />);
    await screen.findByText('Kokoro multi-lang');

    fireEvent.click(within(row('piper-lessac-medium')).getByText('Cancel'));
    await waitFor(() => expect(server.calls('/api/voice/local/models/cancel')).toHaveLength(1));
    expect(server.calls('/api/voice/local/models/cancel')[0].body).toEqual({ model: 'piper-lessac-medium' });

    fireEvent.click(within(row('kokoro-multi-lang')).getByText('Redownload'));
    await waitFor(() => expect(server.calls('/api/voice/local/models/download')).toHaveLength(1));
    expect(server.calls('/api/voice/local/models/download')[0].body).toEqual({ model: 'kokoro-multi-lang', fresh: true });

    fireEvent.click(within(row('kokoro-multi-lang')).getByText('Delete'));
    expect(server.calls('/api/voice/local/models/kokoro-multi-lang', 'DELETE')).toHaveLength(0);
    fireEvent.click(within(row('kokoro-multi-lang')).getByText('Delete'));
    await waitFor(() => expect(server.calls('/api/voice/local/models/kokoro-multi-lang', 'DELETE')).toHaveLength(1));
  });

  it('follows a download to the end without a click', async () => {
    const server = stubServer([STT(), VAD(), PIPER('downloading', { pct: 20 }), KOKORO()]);
    render(<VoiceModelsModal />);
    expect(await screen.findByText(/Downloading 20%/)).toBeTruthy();
    server.set([STT(), VAD(), PIPER('ready'), KOKORO()]);
    expect(await screen.findByText(/Installed · 64.1 MB on disk/, undefined, { timeout: 4000 })).toBeTruthy();
  });
});

describe('call bar when an on-device bot has no voice model', () => {
  it('prompts for a model instead of starting a call, and opens the manager', async () => {
    const server = stubServer([STT(), VAD(), PIPER(), KOKORO()]);
    render(<VoiceCallBar />);

    act(() => startCall(SCOUT.id));
    expect(await screen.findByText(/needs a voice model/)).toBeTruthy();
    expect(useVoice.getState().status).toBe('blocked');
    expect(server.sent.some((s) => s.url.includes('/session'))).toBe(false);

    fireEvent.click(screen.getByText('Choose a voice'));
    expect(useConfigUI.getState().voiceModels).toBe(true);

    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(useVoice.getState().status).toBe('idle');
  });

  it('shows download progress while the voice is on its way, then offers to start', async () => {
    const server = stubServer([STT(), VAD(), PIPER('downloading', { pct: 40 }), KOKORO()]);
    render(<VoiceCallBar />);

    act(() => startCall(SCOUT.id));
    expect(await screen.findByText('Downloading on-device voice… 40%')).toBeTruthy();

    server.set([STT(), VAD(), PIPER('ready'), KOKORO()]);
    expect(await screen.findByText('Start call', undefined, { timeout: 4000 })).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bot } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    bots: vi.fn(async () => ({ bots: [], live: [] })),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
}));

import { VoiceSettings } from '../components/VoiceSettings';
import { useStore } from '../store';
import { useVoice } from '../voice/call';

/** A complete Bot, so each test only states what it cares about. */
function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto',
    voiceProvider: 'cloud', voiceModel: 'piper-lessac-medium',
    model: null, provider: null,
    generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

const BOT = bot({ id: 'bot-1', name: 'Scout' });

interface ModelStub {
  id: string; kind: string; name: string; rate: number; size: number; state: string; pct: number; tier: string;
}

interface MenuStub { items: ModelStub[]; ready: boolean }

interface StatusStub {
  available: boolean;
  reason?: string;
  runtime: { platform: string; arch: string; provider: string; addon: boolean };
  models: { stt: string; tts: string; vad: string };
  bytes: { total: number; have: number };
  download: { active: boolean; pct: number; name: string | null };
}

const PIPER: ModelStub = { id: 'piper-lessac-medium', kind: 'tts', name: 'Piper lessac-medium', rate: 22050, size: 64104260, state: 'ready', pct: 100, tier: 'required' };
const KOKORO: ModelStub = { id: 'kokoro-multi-lang', kind: 'tts', name: 'Kokoro multi-lang (54 voices)', rate: 24000, size: 359719088, state: 'missing', pct: 0, tier: 'optional' };

const MENU: MenuStub = {
  items: [
    { id: 'zipformer-bilingual-int8', kind: 'stt', name: 'Zipformer bilingual (zh + en, int8)', rate: 16000, size: 198270793, state: 'ready', pct: 100, tier: 'required' },
    { id: 'silero-vad', kind: 'vad', name: 'Silero VAD', rate: 16000, size: 628522, state: 'ready', pct: 100, tier: 'required' },
    PIPER,
    KOKORO,
  ],
  ready: true,
};

const STATUS: StatusStub = {
  available: true,
  runtime: { platform: 'darwin', arch: 'arm64', provider: 'cpu', addon: true },
  models: { stt: 'ready', tts: 'ready', vad: 'ready' },
  bytes: { total: 263_000_000, have: 263_000_000 },
  download: { active: false, pct: 100, name: null },
};

const OPTIONS = {
  voices: [{ id: 'ara', name: 'Ara' }, { id: 'eve', name: 'Eve' }],
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
  speeds: [0.85, 1, 1.15],
};

interface Sent { url: string; method: string; body: unknown }

/** A `Response`-shaped object: jsdom has no fetch/Response, and the code only reads these fields. */
function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/** Stub fetch for the four routes the panel touches, recording every call. */
function stubServer(over: { menu?: () => MenuStub; status?: StatusStub; patch?: (body: unknown) => Response } = {}) {
  const sent: Sent[] = [];
  let kokoroDownloaded = false;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method, body });

    if (url === '/api/voice/options') return reply(OPTIONS);
    if (url === '/api/voice/local/status') return reply(over.status ?? STATUS);
    if (url === '/api/voice/local/models') {
      const base = over.menu ? over.menu() : MENU;
      return reply({
        ...base,
        items: base.items.map((m) => (m.id === KOKORO.id && kokoroDownloaded ? { ...m, state: 'ready', pct: 100 } : m)),
      });
    }
    if (url === '/api/voice/local/models/download' && method === 'POST') {
      kokoroDownloaded = true;
      return reply({ started: true, model: body?.model ?? null, startedModels: [body?.model], state: STATUS.models, states: { [String(body?.model)]: 'downloading' } });
    }
    if (url.startsWith('/api/bots/') && method === 'PATCH') {
      if (over.patch) return over.patch(body ?? {});
      return reply({ bot: { ...BOT, ...body } });
    }
    return reply({ error: 'unexpected request' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    sent,
    calls: (url: string, method?: string) => sent.filter((s) => s.url === url && (method ? s.method === method : true)),
    setKokoroDownloaded: (v: boolean) => { kokoroDownloaded = v; },
  };
}

let server: ReturnType<typeof stubServer>;

beforeEach(() => {
  const base = useStore.getState();
  useStore.setState({ ...base, bots: [BOT], live: {}, selectedBotId: BOT.id, transcripts: {}, routines: {} });
  server = stubServer();
});

// The panel polls while a download runs; every timer must go with the component.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useVoice.setState({ status: 'idle', botId: null, error: null, captions: [], speaking: false, listening: false, thinking: false, working: [] });
});

const row = (id: string) => document.querySelector<HTMLElement>(`[data-model-id="${id}"]`);

describe('VoiceSettings — on-device voice picker', () => {
  it('lists both TTS voices with rate, size and latency, and offers Download only for the missing one', async () => {
    render(<VoiceSettings bot={BOT} />);

    expect(await screen.findByText(PIPER.name)).toBeTruthy();
    expect(screen.getByText(KOKORO.name)).toBeTruthy();
    // Piper is not the only model on the menu, but it is the only kind that can speak.
    expect(screen.queryByText(/Zipformer/)).toBeNull();
    expect(screen.queryByText(/Silero VAD/)).toBeNull();

    const piper = row(PIPER.id);
    const kokoro = row(KOKORO.id);
    expect(piper?.dataset.state).toBe('ready');
    expect(kokoro?.dataset.state).toBe('missing');

    expect(piper?.textContent).toContain('22.05 kHz');
    expect(piper?.textContent).toContain('64.1 MB');
    expect(piper?.textContent).toContain('Fast');

    expect(kokoro?.textContent).toContain('24 kHz');
    expect(kokoro?.textContent).toContain('360 MB');
    // Quality tier and the honest latency warning; the copy is short ("Best · slower") so a 350 px
    // details panel does not clip it, so assert both properties rather than one exact sentence.
    expect(kokoro?.textContent).toMatch(/Best/);
    expect(kokoro?.textContent).toMatch(/slower/i);

    // Piper is installed and already the bot's voice: selectable, no download needed.
    expect((within(piper!).getByLabelText(`Use ${PIPER.name}`) as HTMLInputElement).disabled).toBe(false);
    expect((within(piper!).getByLabelText(`Use ${PIPER.name}`) as HTMLInputElement).checked).toBe(true);
    expect(within(piper!).queryByLabelText(`Download ${PIPER.name}`)).toBeNull();

    // Kokoro is not on disk: it cannot be chosen yet, and it is the one with the button.
    expect((within(kokoro!).getByLabelText(`Use ${KOKORO.name}`) as HTMLInputElement).disabled).toBe(true);
    expect(within(kokoro!).getByLabelText(`Download ${KOKORO.name}`).textContent).toBe('Download');
  });

  it('downloads Kokoro by id, then polls the menu until that model is ready and lets it be chosen', async () => {
    render(<VoiceSettings bot={BOT} />);
    await screen.findByText(KOKORO.name);

    fireEvent.click(screen.getByLabelText(`Download ${KOKORO.name}`));

    await waitFor(() => expect(server.calls('/api/voice/local/models/download', 'POST')).toHaveLength(1));
    expect(server.calls('/api/voice/local/models/download', 'POST')[0].body).toEqual({ model: 'kokoro-multi-lang' });

    // The download is backgrounded server-side; the panel learns it finished from /models.
    const radio = await waitFor(
      () => {
        const el = screen.getByLabelText(`Use ${KOKORO.name}`) as HTMLInputElement;
        expect(el.disabled).toBe(false);
        return el;
      },
      { timeout: 5000 },
    );

    expect(server.calls('/api/voice/local/models').length).toBeGreaterThan(1);
    expect(row(KOKORO.id)?.dataset.state).toBe('ready');
    expect(screen.queryByLabelText(`Download ${KOKORO.name}`)).toBeNull();

    fireEvent.click(radio);
    await waitFor(() => expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')).toHaveLength(1));
    expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')[0].body).toEqual({ voiceModel: 'kokoro-multi-lang' });
  });

  it('choosing a ready voice PATCHes the bot with its model id', async () => {
    server = stubServer({ menu: () => ({ ...MENU, items: MENU.items.map((m) => (m.id === KOKORO.id ? { ...m, state: 'ready', pct: 100 } : m)) }) });
    render(<VoiceSettings bot={BOT} />);
    await screen.findByText(KOKORO.name);

    const kokoro = screen.getByLabelText(`Use ${KOKORO.name}`) as HTMLInputElement;
    expect(kokoro.disabled).toBe(false);
    expect(kokoro.checked).toBe(false);
    fireEvent.click(kokoro);

    await waitFor(() => expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')).toHaveLength(1));
    expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')[0].body).toEqual({ voiceModel: 'kokoro-multi-lang' });
    // Optimistic: the store already holds the new voice before the server answers (the panel's
    // `bot` prop is the parent's copy, so the store is what a re-render reads).
    expect(useStore.getState().bots.find((b) => b.id === BOT.id)?.voiceModel).toBe('kokoro-multi-lang');
  });

  it('the Cloud / On-device toggle PATCHes voiceProvider optimistically', async () => {
    render(<VoiceSettings bot={BOT} />);
    const cloud = screen.getByLabelText('Cloud voice');
    const onDevice = screen.getByLabelText('On-device voice') as HTMLButtonElement;

    expect(cloud.getAttribute('aria-pressed')).toBe('true');
    // Enabled only once /local/status says this server can run the engine.
    await waitFor(() => expect(onDevice.disabled).toBe(false));
    expect(onDevice.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(onDevice);
    await waitFor(() => expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')).toHaveLength(1));
    expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')[0].body).toEqual({ voiceProvider: 'local' });
    expect(useStore.getState().bots.find((b) => b.id === BOT.id)?.voiceProvider).toBe('local');
    expect(onDevice.getAttribute('data-state')).toBe('idle'); // the prop is the parent's copy, still 'cloud'
  });

  it('switches back to the cloud voice', async () => {
    render(<VoiceSettings bot={{ ...BOT, voiceProvider: 'local' }} />);
    const cloud = screen.getByLabelText('Cloud voice');
    expect(cloud.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(cloud);
    await waitFor(() => expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')).toHaveLength(1));
    expect(server.calls(`/api/bots/${BOT.id}`, 'PATCH')[0].body).toEqual({ voiceProvider: 'cloud' });
    expect(useStore.getState().bots.find((b) => b.id === BOT.id)?.voiceProvider).toBe('cloud');
  });

  it('rolls the provider back and says so when the PATCH fails', async () => {
    server = stubServer({ patch: () => reply({ error: 'nope' }, 500) });
    render(<VoiceSettings bot={BOT} />);
    const onDevice = screen.getByLabelText('On-device voice') as HTMLButtonElement;
    await waitFor(() => expect(onDevice.disabled).toBe(false));

    fireEvent.click(onDevice);

    expect(await screen.findByText(/Couldn’t save that voice/)).toBeTruthy();
    await waitFor(() => expect(useStore.getState().bots.find((b) => b.id === BOT.id)?.voiceProvider).toBe('cloud'));
    expect(onDevice.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the actionable fallback the call path sets when an on-device call had to use the cloud', async () => {
    render(<VoiceSettings bot={BOT} />);
    await screen.findByText(KOKORO.name);

    const note = 'On-device voice isn’t available — the on-device models aren’t downloaded yet. This call is using the cloud voice. Download them under Voice settings to switch back.';
    useVoice.setState({ status: 'live', botId: BOT.id, error: note });

    const el = await screen.findByText(note);
    expect(el.getAttribute('data-state')).toBe('call');
  });

  it('disables On-device with the server’s reason when the runtime cannot run it', async () => {
    server = stubServer({
      status: {
        ...STATUS,
        available: false,
        reason: 'unsupported-runtime',
        runtime: { platform: 'linux', arch: 'x64', provider: 'cpu', addon: false },
        models: { stt: 'missing', tts: 'missing', vad: 'missing' },
        bytes: { total: 263_000_000, have: 0 },
        download: { active: false, pct: 0, name: null },
      },
    });
    render(<VoiceSettings bot={BOT} />);

    const onDevice = await screen.findByLabelText('On-device voice');
    await waitFor(() => expect((onDevice as HTMLButtonElement).disabled).toBe(true));
    expect(onDevice.getAttribute('data-state')).toBe('disabled');
    expect(onDevice.getAttribute('title')).toContain('speech engine');
    expect(screen.getByText(/On-device voice is off: .*speech engine/)).toBeTruthy();
    // The engine cannot load at all, so no voice can be picked or downloaded here.
    expect(screen.queryByText(KOKORO.name)).toBeNull();
  });

  it('keeps On-device usable while the models just are not downloaded yet', async () => {
    server = stubServer({
      status: {
        ...STATUS,
        available: false,
        reason: 'models-missing',
        models: { stt: 'missing', tts: 'missing', vad: 'missing' },
        bytes: { total: 263_000_000, have: 0 },
        download: { active: false, pct: 0, name: null },
      },
    });
    render(<VoiceSettings bot={BOT} />);

    const onDevice = await screen.findByLabelText('On-device voice') as HTMLButtonElement;
    expect(onDevice.disabled).toBe(false);
    expect(screen.getByText(/Not downloaded \(0 of 263 MB\)/)).toBeTruthy();
  });
});

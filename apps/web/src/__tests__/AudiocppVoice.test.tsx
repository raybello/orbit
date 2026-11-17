import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AudiocppStatus, Bot } from '@orbit/contracts';

vi.mock('../lib/api', () => ({
  api: {
    bots: vi.fn(async () => ({ bots: [], live: [] })),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
}));

import { VoiceSettings } from '../components/VoiceSettings';
import { gpuLine, voiceLabel } from '../components/voice/AudiocppSettings';
import { dueFrame, parseBinaryFrame, FRAME_AUDIO, FRAME_VIDEO } from '../voice/audiocpp-call';
import { useStore } from '../store';
import { useVoice } from '../voice/call';

function bot(over: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue',
    mode: 'personal', isPrimary: false, kind: 'agent', pinned: false, effort: 'medium',
    voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto',
    voiceProvider: 'cloud', voiceModel: 'piper-lessac-medium',
    audiocppVoice: 'american_english_female', avatarEnabled: false, hasPortrait: false,
    model: null, provider: null, initiative: 'proactive',
    generation: 0, unread: 0, lastPreview: null, lastActivityAt: 0, createdAt: 0,
    ...over,
  };
}

const READY: AudiocppStatus = {
  available: true, url: 'http://127.0.0.1:8080', models: { 'chat-recognition': true, 'chat-voice': true, 'chat-avatar': true },
  avatar: true, download: null, managed: false, voices: ['american_english_female', 'british_english_male'],
};

function reply(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: { get: () => null },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

interface Sent { url: string; method: string; body: unknown }

function stubServer(gpu: AudiocppStatus | null, current: () => Bot) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    sent.push({ url, method, body });
    if (url === '/api/voice/options') return reply({ voices: [{ id: 'ara', name: 'Ara' }], languages: [{ code: 'auto', name: 'Auto' }], speeds: [1] });
    if (url === '/api/voice/local/status') return reply({ error: 'gone' }, 404);
    if (url === '/api/voice/local/models') return reply({ error: 'gone' }, 404);
    if (url === '/api/voice/audiocpp/status') return gpu ? reply(gpu) : reply({ error: 'gone' }, 404);
    if (url.startsWith('/api/voice/audiocpp/portrait/') && method === 'POST') return reply({ bot: { ...current(), hasPortrait: true, avatarEnabled: true } });
    if (url.startsWith('/api/voice/audiocpp/portrait/') && method === 'DELETE') return reply({ bot: { ...current(), hasPortrait: false, avatarEnabled: false } });
    if (url.startsWith('/api/bots/') && method === 'PATCH') return reply({ bot: { ...current(), ...(body as object) } });
    return reply({ error: 'unexpected' }, 404);
  }));
  return { sent, calls: (u: string, m?: string) => sent.filter((s) => s.url === u && (!m || s.method === m)) };
}

function setBot(b: Bot) {
  useStore.setState({ ...useStore.getState(), bots: [b], live: {}, selectedBotId: b.id, transcripts: {}, routines: {} });
}
const live = (id: string) => useStore.getState().bots.find((b) => b.id === id)!;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useVoice.setState({ status: 'idle', botId: null, error: null, captions: [], speaking: false, listening: false, thinking: false, working: [] });
});

describe('GPU voice wire helpers', () => {
  it('parses typed binary frames', () => {
    const audio = new Uint8Array([FRAME_AUDIO, 0x10, 0x00, 0xf0, 0xff]).buffer;
    const a = parseBinaryFrame(audio);
    expect(a?.type).toBe('audio');
    expect(a && a.type === 'audio' ? [...a.pcm] : null).toEqual([16, -16]);
    const video = new Uint8Array([FRAME_VIDEO, 0x05, 0x01, 0xff, 0xd8]).buffer;
    const v = parseBinaryFrame(video);
    expect(v && v.type === 'video' ? [v.index, [...v.jpeg]] : null).toEqual([261, [0xff, 0xd8]]);
    expect(parseBinaryFrame(new Uint8Array([9, 1]).buffer)).toBeNull();
    expect(parseBinaryFrame(new ArrayBuffer(0))).toBeNull();
  });

  it('schedules frames on the audio clock', () => {
    const chunks = [{ start: 10, frames: 24, fps: 25 }, { start: 10.96, frames: 24, fps: 25 }, { start: null, frames: 24, fps: 25 }];
    expect(dueFrame(chunks, 9.99)).toBeNull();
    expect(dueFrame(chunks, 10)).toEqual({ chunk: 0, frame: 0 });
    expect(dueFrame(chunks, 10.5)).toEqual({ chunk: 0, frame: 12 });
    expect(dueFrame(chunks, 10.97)).toEqual({ chunk: 1, frame: 0 });
    expect(dueFrame(chunks, 11.95)).toBeNull();
  });

  it('labels voices and status lines', () => {
    expect(voiceLabel('british_english_male')).toBe('British English · male');
    expect(gpuLine(null)).toBe('Checking…');
    expect(gpuLine(READY)).toBe('Ready · speech + avatar');
    expect(gpuLine({ ...READY, available: false, reason: 'downloading', download: { state: 'downloading', pct: 37, file: 'x' } })).toBe('GPU voice loading… 37%');
    expect(gpuLine({ ...READY, available: false, reason: 'unreachable' })).toMatch(/isn’t answering/);
  });
});

describe('VoiceSettings with GPU voice', () => {
  beforeEach(() => setBot(bot({ id: 'b1', name: 'Nova' })));

  it('offers GPU when audio.cpp is up, and saves the choice', async () => {
    const s = stubServer(READY, () => live('b1'));
    render(<VoiceSettings bot={live('b1')} />);
    const gpu = await screen.findByRole('button', { name: 'GPU voice' });
    await waitFor(() => expect((gpu as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(gpu);
    await waitFor(() => expect(s.calls('/api/bots/b1', 'PATCH')).toHaveLength(1));
    expect(s.calls('/api/bots/b1', 'PATCH')[0].body).toEqual({ voiceProvider: 'audiocpp' });
    expect(live('b1').voiceProvider).toBe('audiocpp');
  });

  it('disables GPU when audio.cpp is unreachable', async () => {
    stubServer({ ...READY, available: false, reason: 'unreachable', models: {}, avatar: false }, () => live('b1'));
    render(<VoiceSettings bot={live('b1')} />);
    const gpu = await screen.findByRole('button', { name: 'GPU voice' });
    await waitFor(() => expect((gpu as HTMLButtonElement).disabled).toBe(true));
    expect(gpu.getAttribute('title')).toBe('GPU voice not available');
  });

  it('a GPU bot picks its voice, uploads a portrait and toggles the avatar', async () => {
    setBot(bot({ id: 'b1', name: 'Nova', voiceProvider: 'audiocpp' }));
    const s = stubServer(READY, () => live('b1'));
    const { rerender } = render(<VoiceSettings bot={live('b1')} />);
    await screen.findByText('Ready · speech + avatar');

    fireEvent.change(screen.getByLabelText('GPU speaking voice'), { target: { value: 'british_english_male' } });
    await waitFor(() => expect(s.calls('/api/bots/b1', 'PATCH')).toHaveLength(1));
    expect(s.calls('/api/bots/b1', 'PATCH')[0].body).toEqual({ audiocppVoice: 'british_english_male' });

    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'me.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Portrait image'), { target: { files: [file] } });
    await waitFor(() => expect(s.calls('/api/voice/audiocpp/portrait/b1', 'POST')).toHaveLength(1));
    expect(s.calls('/api/voice/audiocpp/portrait/b1', 'POST')[0].body).toBeInstanceOf(FormData);
    await waitFor(() => expect(live('b1').hasPortrait).toBe(true));

    rerender(<VoiceSettings bot={live('b1')} />);
    const toggle = await screen.findByLabelText('Show animated avatar during calls');
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(s.calls('/api/bots/b1', 'PATCH')).toHaveLength(2));
    expect(s.calls('/api/bots/b1', 'PATCH')[1].body).toEqual({ avatarEnabled: false });
  });

  it('shows first-run download progress and polls until ready', async () => {
    setBot(bot({ id: 'b1', name: 'Nova', voiceProvider: 'audiocpp' }));
    stubServer({ ...READY, available: false, reason: 'downloading', models: {}, managed: true, download: { state: 'downloading', pct: 37, file: 'x.gguf' } }, () => live('b1'));
    render(<VoiceSettings bot={live('b1')} />);
    await screen.findByText('GPU voice loading… 37%');
    expect(screen.getByRole('progressbar', { name: 'GPU model download progress' }).getAttribute('aria-valuenow')).toBe('37');
  });
});

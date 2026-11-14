import assert from 'node:assert/strict';
import test from 'node:test';
import { LOCAL_TTS_RATE, localModels, downloadLocalModel, parseLocalPreviewResponse, voiceApi } from '../voice/api.js';

// The on-device voice API helpers, checked against the real route shapes from
// docs/voice-local-conventions.md (Phase 3): URLs, bodies, the X-Audio-Rate parse and 409 surfacing.
// `fetch` is stubbed — no server, no jsdom.

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

/** Replace global fetch; returns the recorded calls and a way to restore it. */
function stubFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers((init?.headers ?? {}) as Record<string, string>).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      headers,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const MODELS = {
  items: [
    { id: 'zipformer-bilingual-int8', kind: 'stt', name: 'Zipformer bilingual (zh + en, int8)', rate: 16000, size: 198270793, state: 'ready', pct: 100, tier: 'required' },
    { id: 'sirocco-vad', kind: 'vad', name: 'Silero VAD', rate: 16000, size: 628522, state: 'ready', pct: 100, tier: 'required' },
    { id: 'piper-lessac-medium', kind: 'tts', name: 'Piper lessac-medium', rate: 22050, size: 64104260, state: 'ready', pct: 100, tier: 'required' },
    { id: 'kokoro-multi-lang', kind: 'tts', name: 'Kokoro multi-lang (54 voices)', rate: 24000, size: 359719088, state: 'missing', pct: 0, tier: 'optional' },
  ],
  ready: true,
};

test('localModels reads GET /api/voice/local/models once, then serves the cache until refreshed', async () => {
  const { calls, restore } = stubFetch(() => json(MODELS));
  try {
    const first = await localModels();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/voice/local/models');
    assert.equal(calls[0].method, 'GET');
    assert.equal(first.items.filter((m) => m.kind === 'tts').length, 2);
    assert.equal(first.items.find((m) => m.id === 'kokoro-multi-lang')?.size, 359719088);
    assert.equal(first.ready, true);

    await localModels();
    assert.equal(calls.length, 1, 'a second read must not hit the network');

    const fresh = await localModels(true);
    assert.equal(calls.length, 2, 'refresh bypasses the cache');
    assert.equal(fresh.items.length, 4);
  } finally {
    restore();
  }
});

test('localModels drops the cache entry when the request fails, so the next call retries', async () => {
  let n = 0;
  const { calls, restore } = stubFetch(() => (++n === 1 ? new Response('down', { status: 503 }) : json(MODELS)));
  try {
    await assert.rejects(localModels(true), /HTTP 503/);
    const ok = await localModels(true);
    assert.equal(calls.length, 2);
    assert.equal(ok.items.length, 4);
  } finally {
    restore();
  }
});

test('downloadLocalModel POSTs the model id to /api/voice/local/models/download', async () => {
  const { calls, restore } = stubFetch(() => json({
    started: true, model: 'kokoro-multi-lang', startedModels: ['kokoro-multi-lang'],
    state: { stt: 'ready', tts: 'ready', vad: 'ready' },
    states: { 'kokoro-multi-lang': 'downloading' },
  }, 200));
  try {
    const r = await downloadLocalModel('kokoro-multi-lang');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/voice/local/models/download');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { model: 'kokoro-multi-lang' });
    assert.match(calls[0].headers['content-type'], /application\/json/);
    assert.equal(r.started, true);
    assert.equal(r.states['kokoro-multi-lang'], 'downloading');
  } finally {
    restore();
  }
});

test('localPreview sends the chosen model and reads the engine rate from X-Audio-Rate', async () => {
  const pcm = new Int16Array([100, -100, 32767]);
  const { calls, restore } = stubFetch(() => new Response(new Uint8Array(pcm.buffer), {
    status: 200,
    headers: { 'Content-Type': 'audio/pcm', 'X-Audio-Rate': '24000', 'X-Audio-Model': 'kokoro-multi-lang' },
  }));
  try {
    const out = await voiceApi.localPreview({ text: 'Hello there', speed: 1, model: 'kokoro-multi-lang' });
    assert.equal(calls[0].url, '/api/voice/local/preview');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { text: 'Hello there', speed: 1, model: 'kokoro-multi-lang' });
    assert.equal(out.rate, 24000, 'Kokoro speaks at 24 kHz, never resampled to the Piper rate');
    assert.deepEqual([...out.pcm], [100, -100, 32767]);
  } finally {
    restore();
  }
});

test('a preview without a model still uses the Piper rate as the documented fallback', () => {
  const parsed = parseLocalPreviewResponse(new Headers({}), new Int16Array([1, 2]).buffer);
  assert.equal(parsed.rate, LOCAL_TTS_RATE);
  assert.equal(LOCAL_TTS_RATE, 22050);
});

test('a 409 from /preview surfaces the server’s reason instead of a generic message', async () => {
  const { restore } = stubFetch(() => json({ error: 'model not downloaded', model: 'kokoro-multi-lang', tier: 'optional' }, 409));
  try {
    await assert.rejects(
      () => voiceApi.localPreview({ text: 'Hi', model: 'kokoro-multi-lang' }),
      (e: Error) => {
        assert.equal(e.message, 'model not downloaded');
        assert.doesNotMatch(e.message, /Preview unavailable/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('an unknown model id on /preview surfaces as 409 too', async () => {
  const { restore } = stubFetch(() => json({ error: 'unknown model', model: 'nope', models: ['piper-lessac-medium', 'kokoro-multi-lang'] }, 409));
  try {
    await assert.rejects(() => voiceApi.localPreview({ text: 'Hi', model: 'nope' }), /unknown model/);
  } finally {
    restore();
  }
});

test('saveBotVoice PATCHes only the voice keys it was given', async () => {
  const { calls, restore } = stubFetch(() => json({ bot: { id: 'bot-1', voiceProvider: 'local', voiceModel: 'piper-lessac-medium' } }));
  try {
    const r = await voiceApi.saveBotVoice('bot-1', { voiceProvider: 'local' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/bots/bot-1');
    assert.equal(calls[0].method, 'PATCH');
    assert.deepEqual(calls[0].body, { voiceProvider: 'local' }, 'an untouched field must not be sent');
    assert.match(calls[0].headers['content-type'], /application\/json/);
    assert.equal(r.bot.voiceProvider, 'local');

    await voiceApi.saveBotVoice('bot-1', { voiceModel: 'kokoro-multi-lang' });
    assert.deepEqual(calls[1].body, { voiceModel: 'kokoro-multi-lang' });
  } finally {
    restore();
  }
});

test('saveBotVoice surfaces a failed PATCH instead of pretending it saved', async () => {
  const { restore } = stubFetch(() => json({ error: 'not found' }, 404));
  try {
    await assert.rejects(() => voiceApi.saveBotVoice('missing', { voiceProvider: 'local' }), /not found/);
  } finally {
    restore();
  }
});

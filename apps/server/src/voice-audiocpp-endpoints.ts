/**
 * GPU voice over HTTP, mounted by voice.ts at `/api/voice/audiocpp/*`:
 *
 *   GET    /status             audio.cpp health, which models are loaded, model download progress
 *   POST   /session            mint a call id → { callId, sampleRate, ttsSampleRate, hasAvatar, voice }
 *   WS     /call/:callId       the call itself (attachAudiocppCallRelay in voice-audiocpp-session.ts)
 *   POST   /preview            hear an LFM3-Audio voice: PCM16 at X-Audio-Rate
 *   POST   /models/download    fetch the models in the Docker sidecar (docker exec download-models.py)
 *   GET    /portrait/:botId    the bot's portrait (JPEG)
 *   POST   /portrait/:botId    upload one (multipart `file`); stored as a 512x512 JPEG
 *   DELETE /portrait/:botId    remove it
 *
 * Never falls back silently: an unreachable audio.cpp answers `available: false` with a reason, and
 * the client decides what to tell the person.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { AUDIOCPP_VOICES, resolveAudiocppVoice, type AudiocppStatus } from '@orbit/contracts';
import { requireUser, type AuthVars } from './lib/auth.js';
import { newId } from './lib/ids.js';
import { db, now } from './db.js';
import { env } from './env.js';
import { emitBot, getBot, getBotRow } from './store.js';
import * as audiocpp from './voice-audiocpp.js';
import { AUDIOCPP_CALL_SAMPLE_RATE, AUDIOCPP_CALL_TTS_RATE, createAudiocppCall, loadSharp } from './voice-audiocpp-session.js';

export const audiocppVoiceApi = new Hono<AuthVars>();
audiocppVoiceApi.use('*', requireUser);

/** Portrait side length: SoulX-FlashHead's default output size, so the model never rescales. */
export const PORTRAIT_SIZE = 512;
const MAX_PORTRAIT_BYTES = 15 * 1024 * 1024;
const MAX_PREVIEW_TEXT = 300;
/** Containers carrying this label are the audio.cpp sidecar (infra/compose/docker-compose.yml). */
const SIDECAR_LABEL = 'orbit.role=audiocpp';

function ownBot(userId: string, botId: string | undefined) {
  if (!botId) return null;
  const b = getBotRow(botId);
  return b && b.user_id === userId ? b : null;
}

// ---------- status ----------

type DownloadState = NonNullable<AudiocppStatus['download']>;

/** The sidecar's download status file on the shared volume; null where there is no sidecar volume. */
export function readDownloadStatus(dir = env.audiocppModelsDir): DownloadState | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, '.orbit-status.json'), 'utf8')) as Partial<DownloadState> & { updated_at?: number };
    const state = (['missing', 'downloading', 'ready', 'error'] as const).find((s) => s === j.state);
    if (!state) return null;
    // A "downloading" file nobody has touched for two minutes belongs to a downloader that died.
    const stale = state === 'downloading' && typeof j.updated_at === 'number' && Date.now() - j.updated_at > 120_000;
    return {
      state: stale ? 'error' : state,
      pct: Math.max(0, Math.min(100, Number(j.pct) || 0)),
      file: typeof j.file === 'string' ? j.file : null,
      ...(stale ? { error: 'the download stopped; start it again' } : j.error ? { error: String(j.error) } : {}),
    };
  } catch {
    return null;
  }
}

let sidecarCache: { at: number; id: string | null } | null = null;

/** The running audio.cpp sidecar container's id, found by label (cached 30 s). */
async function sidecarContainer(): Promise<string | null> {
  if (sidecarCache && Date.now() - sidecarCache.at < 30_000) return sidecarCache.id;
  let id: string | null = null;
  try {
    const { docker } = await import('./docker/client.js');
    const list = await docker().listContainers({ all: false, filters: { label: [SIDECAR_LABEL] } });
    id = list[0]?.Id ?? null;
  } catch {
    id = null; // no Docker here: a native audio.cpp server manages its own models
  }
  sidecarCache = { at: Date.now(), id };
  return id;
}

export async function audiocppStatus(): Promise<AudiocppStatus> {
  const download = readDownloadStatus();
  const managed = !!(await sidecarContainer());
  const base = { url: env.audiocppUrl, download, managed, voices: AUDIOCPP_VOICES };
  const health = await audiocpp.audiocppReady();
  if (!health.ok) {
    // While the sidecar waits for its models the server is deliberately not running.
    const reason = download?.state === 'downloading' ? 'downloading' : download && download.state !== 'ready' ? 'models-missing' : health.reason;
    return { available: false, reason, models: {}, avatar: false, ...base };
  }
  let list: audiocpp.AudiocppModelInfo[] = [];
  try {
    list = await audiocpp.audiocppModels();
  } catch {
    return { available: false, reason: 'server-error', models: {}, avatar: false, ...base };
  }
  const models: Record<string, boolean> = {};
  for (const id of Object.values(audiocpp.AUDIOCPP_MODELS)) {
    const m = list.find((x) => x.id === id);
    if (m) models[id] = m.loaded !== false;
  }
  const { asr, tts, avatar } = audiocpp.AUDIOCPP_MODELS;
  const configured = asr in models && tts in models;
  // A configured model that is unloaded reloads on its first request (lazy load / idle unload), so
  // only a missing entry makes the server unusable.
  return {
    available: configured,
    ...(configured ? {} : { reason: 'models-not-loaded' as const }),
    models,
    avatar: avatar in models,
    ...base,
  };
}

audiocppVoiceApi.get('/status', async (c) => c.json(await audiocppStatus()));

// ---------- session ----------

/**
 * The bot's portrait as a path the audio.cpp server can open. Uploaded through the server's own
 * upload endpoint, which works for a native server on this host, a remote GPU box and the sidecar
 * alike; a server with uploads disabled falls back to the file's path on the shared data volume.
 */
async function portraitForServer(file: string, botId: string): Promise<string | null> {
  if (!fs.existsSync(file)) return null;
  try {
    const uploaded = await audiocpp.uploadToServer(fs.readFileSync(file), `orbit-portrait-${botId}.jpg`);
    if (uploaded) return uploaded;
  } catch (e) {
    console.warn('[voice] audiocpp portrait upload failed:', (e as Error)?.message);
  }
  return path.resolve(file);
}

audiocppVoiceApi.post('/session', async (c) => {
  const user = c.get('user');
  const p = await c.req.json<{ botId?: string }>().catch(() => ({}) as { botId?: string });
  const bot = ownBot(user.id, p.botId);
  if (!bot) return c.json({ error: 'not found' }, 404);
  const status = await audiocppStatus();
  if (!status.available) return c.json({ available: false, reason: status.reason, error: 'GPU voice is not available' }, 503);

  const wantsAvatar = !!bot.avatar_enabled && !!bot.avatar_portrait_path && status.avatar;
  const portraitPath = wantsAvatar ? await portraitForServer(bot.avatar_portrait_path!, bot.id) : null;
  const voice = resolveAudiocppVoice(bot.audiocpp_voice);
  const callId = newId('call');
  createAudiocppCall(callId, bot.id, { voice, portraitPath, language: bot.voice_language ?? 'auto' });
  return c.json({
    callId,
    sampleRate: AUDIOCPP_CALL_SAMPLE_RATE,
    ttsSampleRate: AUDIOCPP_CALL_TTS_RATE,
    hasAvatar: !!portraitPath,
    voice,
  });
});

// ---------- preview ----------

audiocppVoiceApi.post('/preview', async (c) => {
  const user = c.get('user');
  const p = await c.req.json<{ text?: string; voice?: string; botId?: string }>().catch(() => ({}) as { text?: string; voice?: string; botId?: string });
  if (p.botId && !ownBot(user.id, p.botId)) return c.json({ error: 'not found' }, 404);
  const text = String(p.text ?? '').trim().slice(0, MAX_PREVIEW_TEXT);
  if (!text) return c.json({ error: 'text required' }, 400);
  try {
    const out = await audiocpp.synthesize(text, resolveAudiocppVoice(p.voice), AbortSignal.timeout(30_000));
    return c.body(new Uint8Array(out.pcm.buffer, out.pcm.byteOffset, out.pcm.byteLength) as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'audio/pcm',
      'X-Audio-Rate': String(out.rate),
      'Cache-Control': 'no-store',
    });
  } catch (e) {
    console.warn('[voice] audiocpp preview failed:', (e as Error)?.message);
    return c.json({ error: 'preview unavailable' }, 502);
  }
});

// ---------- model download (Docker sidecar) ----------

audiocppVoiceApi.post('/models/download', async (c) => {
  const id = await sidecarContainer();
  if (!id) {
    return c.json({ started: false, managed: false, error: 'No audio.cpp container in this stack. A native audio.cpp server manages its own models.' }, 409);
  }
  const current = readDownloadStatus();
  if (current?.state === 'downloading') return c.json({ started: false, managed: true, download: current });
  try {
    const { docker } = await import('./docker/client.js');
    const exec = await docker().getContainer(id).exec({
      Cmd: ['python3', '/opt/audiocpp/download-models.py'],
      AttachStdout: false,
      AttachStderr: false,
    });
    // Detached: progress is polled from /status through the shared volume.
    await exec.start({ Detach: true });
    return c.json({ started: true, managed: true });
  } catch (e) {
    sidecarCache = null;
    console.warn('[voice] audiocpp model download failed to start:', (e as Error)?.message);
    return c.json({ started: false, managed: true, error: 'Could not start the download' }, 502);
  }
});

// ---------- portraits ----------

export function portraitFile(botId: string): string {
  return path.join(env.audiocppPortraitsDir, `${botId.replace(/[^\w-]/g, '_')}.jpg`);
}

/** Any image → a 512x512 JPEG, cropped around the most interesting region (the face, usually). */
export async function normalizePortrait(bytes: Buffer): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp(bytes, { failOn: 'error' })
    .rotate() // honour EXIF orientation from phone cameras
    .resize(PORTRAIT_SIZE, PORTRAIT_SIZE, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function botFor(c: Context<AuthVars>) {
  return ownBot(c.get('user').id, c.req.param('botId'));
}

audiocppVoiceApi.get('/portrait/:botId', (c) => {
  const bot = botFor(c);
  if (!bot?.avatar_portrait_path || !fs.existsSync(bot.avatar_portrait_path)) return c.json({ error: 'not found' }, 404);
  return c.body(new Uint8Array(fs.readFileSync(bot.avatar_portrait_path)), 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-cache' });
});

audiocppVoiceApi.post('/portrait/:botId', async (c) => {
  const bot = botFor(c);
  if (!bot) return c.json({ error: 'not found' }, 404);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') return c.json({ error: 'file required' }, 400);
  if (file.size > MAX_PORTRAIT_BYTES) return c.json({ error: 'image too large (15 MB max)' }, 413);
  let jpeg: Buffer;
  try {
    jpeg = await normalizePortrait(Buffer.from(await file.arrayBuffer()));
  } catch {
    return c.json({ error: 'That file is not an image we can read.' }, 400);
  }
  const dest = portraitFile(bot.id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, jpeg);
  // A new portrait is meant to be seen: switch the avatar on with it.
  db.prepare('UPDATE bots SET avatar_portrait_path=?, avatar_enabled=1, updated_at=? WHERE id=?').run(dest, now(), bot.id);
  emitBot(bot.id);
  return c.json({ bot: getBot(bot.id), bytes: jpeg.length });
});

audiocppVoiceApi.delete('/portrait/:botId', (c) => {
  const bot = botFor(c);
  if (!bot) return c.json({ error: 'not found' }, 404);
  if (bot.avatar_portrait_path) fs.rmSync(bot.avatar_portrait_path, { force: true });
  db.prepare('UPDATE bots SET avatar_portrait_path=NULL, avatar_enabled=0, updated_at=? WHERE id=?').run(now(), bot.id);
  emitBot(bot.id);
  return c.json({ bot: getBot(bot.id) });
});

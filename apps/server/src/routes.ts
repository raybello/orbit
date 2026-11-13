import crypto from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ORBIT_HEADERS, type DesktopConfigResponse, type DesktopProbeResponse, type PushPlatform, type PushRegisterRequest, type SignInResponse } from '@orbit/contracts';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { createSession, destroySession, isOwnerKey, issueSessionToken, requireUser, userFromAuthorizationHeader, userFromCookieHeader, userFromToken, type AuthVars } from './lib/auth.js';
import { stackTokenMatches } from './lib/stack.js';
import { hermesConnected } from './lib/hermes-probe.js';
import { registerPushToken, removePushTokens } from './push.js';
import { allLive, appendRow, clearConversation, emitBot, getBot, getBotRow, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow } from './store.js';
import { enqueue, interrupt, resolveApproval } from './agent/loop.js';
import { computerState, ensureComputer, forgetBotFiles, readyScreen, refreshComputer, releaseScreen, suspendComputer } from './computer.js';
import { computerKindFor, providerFor, registerBotComputer, releaseBotComputer } from './computer-provider-registry.js';
import { assignEngine, provisionEngine, removeEngine, syncPersona } from './engine.js';
import { deleteMemory, listMemories, memoryBot } from './engine-memory.js';
import { orgo } from './orgo.js';
import { catalog, composioEnabled, connectedToolkits, deleteConnection, disconnect, googleProfile, startConnect, startGoogleLogin, toolkitInfo } from './composio.js';
import { generateAuthUrl, exchangeCode, hasGoogleAccess, googleEmail, revokeGoogle } from './google-oauth.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { voiceApi } from './voice.js';
import type { AvatarColor, AvatarShape, Toolkit } from './types.js';

export const api = new Hono<AuthVars>();

const SHAPES: AvatarShape[] = ['blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome', 'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star'];
const COLORS: AvatarColor[] = ['black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'];

function hashPick<T>(id: string, list: T[]): T {
  let h = 0x811c9dc5;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return list[h % list.length];
}

/** Thrown for things the user can fix; the message is shown to them. */
class UserError extends Error {}

const agentCount = () => (db.prepare("SELECT COUNT(*) n FROM bots WHERE COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").get() as any).n as number;

function createBot(userId: string, b: { name: string; label?: string; description?: string; instructions?: string; avatarShape?: string; avatarColor?: string; mode?: string; isPrimary?: boolean }) {
  // Every bot needs a screen of its own on the one shared computer.
  if (agentCount() >= env.maxBots) throw new UserError(`The team is full: the computer has room for ${env.maxBots} bots. Remove one to add another.`);
  const id = newId('bot');
  const shape = SHAPES.includes(b.avatarShape as AvatarShape) ? b.avatarShape : hashPick(id, SHAPES.slice(0, 13));
  const color = COLORS.includes(b.avatarColor as AvatarColor) ? b.avatarColor : hashPick(id, COLORS.filter((c) => c !== 'black'));
  db.prepare(
    'INSERT INTO bots(id,user_id,name,label,description,instructions,avatar_shape,avatar_color,mode,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(id, userId, b.name.trim().slice(0, 60) || 'New Bot', b.label ?? '', b.description ?? '', b.instructions ?? '', shape, color, b.mode === 'teammate' ? 'teammate' : 'personal', b.isPrimary ? 1 : 0, now(), now());
  // The first bot is the agent that already runs on the computer; the others get an engine of their own.
  // A managed Bot starts on the default model (DeepSeek flash unless configured otherwise).
  if (assignEngine(id) === 'managed') {
    db.prepare('UPDATE bots SET model=?, provider=? WHERE id=? AND model IS NULL').run(env.defaultBotModel, env.defaultBotProvider, id);
    provisionEngine(id);
  }
  // Where this bot's desktop lives is fixed now (a container for managed bots, the shared computer
  // for the first one); see computer-provider-registry.ts.
  registerBotComputer(id);
  hub.emit(userId, { type: 'roster' });
  return getBot(id)!;
}

function findOrCreateUser(email: string, name?: string, preferId?: string) {
  const existing = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email) as any;
  if (existing) return { id: existing.id as string, isNew: false };
  if (env.allowedEmails.length && !env.allowedEmails.includes(email.toLowerCase())) throw new UserError('This account is not allowed to sign in here.');
  const id = preferId ?? newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, name ?? email.split('@')[0], now());
  createBot(id, { name: env.primaryBotName, label: env.primaryBotLabel, description: 'Your main point of contact. Checks in proactively and coordinates work with your other Bots.', avatarShape: 'blob', avatarColor: 'black', isPrimary: true });
  return { id, isNew: true };
}

// ---------- auth ----------

api.get('/auth/me', (c) => {
  const user = userFromCookieHeader(c.req.header('cookie')) ?? userFromAuthorizationHeader(c.req.header('authorization'));
  return c.json({ user, devLogin: env.devLogin });
});

api.get('/auth/google/start', async (c) => {
  if (!composioEnabled()) return c.redirect(`${env.appUrl}/?login=failed&reason=composio_unconfigured`);
  const attemptId = newId('login');
  const provisional = newId('usr');
  const cb = `${env.serverUrl}/api/auth/google/callback?attempt=${attemptId}`;
  const { redirectUrl, connectedAccountId } = await startGoogleLogin(provisional, cb);
  db.prepare('INSERT INTO login_attempts(id,provisional_user_id,connected_account_id,created_at) VALUES (?,?,?,?)').run(attemptId, provisional, connectedAccountId ?? null, now());
  return c.redirect(redirectUrl);
});

api.get('/auth/google/callback', async (c) => {
  const attempt = db.prepare('SELECT * FROM login_attempts WHERE id=?').get(c.req.query('attempt') ?? '') as any;
  const caId = c.req.query('connected_account_id') ?? attempt?.connected_account_id;
  if (!attempt || c.req.query('status') === 'failed' || !caId) return c.redirect(`${env.appUrl}/?login=failed`);
  if (attempt.connected_account_id && caId !== attempt.connected_account_id) return c.redirect(`${env.appUrl}/?login=failed`);
  db.prepare('DELETE FROM login_attempts WHERE id=?').run(attempt.id);
  try {
    const profile = await googleProfile(caId);
    const { id, isNew } = findOrCreateUser(profile.email, profile.name, attempt.provisional_user_id);
    // Existing user: the Gmail connection made for sign-in belongs to a throwaway id; remove it.
    if (!isNew && id !== attempt.provisional_user_id) await deleteConnection(caId);
    createSession(c, id);
    return c.redirect(`${env.appUrl}/`);
  } catch (e: any) {
    console.error('[auth] google callback', e);
    return c.redirect(`${env.appUrl}/?login=failed`);
  }
});

api.post('/auth/dev', async (c) => {
  if (!env.devLogin) return c.json({ error: 'disabled' }, 403);
  const { email, name } = await c.req.json<{ email: string; name?: string }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name);
    createSession(c, id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

/**
 * Sign-in for the native clients: same sessions table as the cookie flow, but the token comes back
 * in the body (and no cookie is set), so it can live in expo-secure-store or the desktop keystore.
 * Only the owner key, or a dev server, may mint one — there is no password store to check against.
 */
api.post('/auth/sign-in', async (c) => {
  const body = await c.req.json<{ email?: string; name?: string; ownerKey?: string }>().catch(() => ({} as any));
  const email = String(body?.email ?? '').trim();
  const byOwnerKey = Boolean(body?.ownerKey) && isOwnerKey(String(body.ownerKey));
  if (!byOwnerKey && !env.devLogin) return c.json({ error: 'owner key required' }, 403);
  if (!email.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, body?.name);
    const { token, expiresAt } = issueSessionToken(id);
    const user = userFromToken(token);
    if (!user) return c.json({ error: 'could not sign in' }, 500);
    return c.json({ ok: true, token, user, expiresAt } satisfies SignInResponse);
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

/** One-time sign-in links made by the owner endpoint. Kept in memory: a restart drops them. */
const signInLinks = new Map<string, { userId: string; expires: number }>();

// Sign-in for whoever runs the server, without Google: the key only exists on the machine (see isOwnerKey).
// With `link`, it answers with a link that signs one browser in, once (scripts/sign-in-link.sh).
api.post('/auth/owner', async (c) => {
  if (!isOwnerKey((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''))) return c.json({ error: 'forbidden' }, 403);
  const { email, name, link } = await c.req.json<{ email: string; name?: string; link?: boolean }>();
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name);
    if (link) {
      const token = crypto.randomBytes(24).toString('base64url');
      signInLinks.set(token, { userId: id, expires: Date.now() + 15 * 60_000 });
      return c.json({ ok: true, url: `${env.appUrl}/api/auth/link/${token}` });
    }
    createSession(c, id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e instanceof UserError ? e.message : 'could not sign in' }, 403);
  }
});

api.get('/auth/link/:token', (c) => {
  const token = c.req.param('token');
  const l = signInLinks.get(token);
  signInLinks.delete(token);
  if (!l || l.expires < Date.now()) return c.text('This sign-in link was already used or has expired. Ask for a new one.', 410);
  createSession(c, l.userId);
  return c.redirect('/');
});

api.post('/auth/logout', (c) => { destroySession(c); return c.json({ ok: true }); });

// everything below requires a session
api.use('/*', async (c, next) => {
  // /api/desktop/probe is authenticated by the stack token itself (see its handler).
  if (c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/apps/callback') || c.req.path === '/api/health' || c.req.path === '/api/desktop/probe') return next();
  return requireUser(c, next);
});

// ---------- events (SSE) ----------

api.get('/events', (c) => {
  const user = c.get('user');
  const sinceRaw = c.req.query('since');
  const sinceSeq = sinceRaw !== undefined && sinceRaw !== '' ? Number(sinceRaw) : null;
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { queue.push(JSON.stringify(ev)); wake?.(); });
    stream.onAbort(() => { unsub(); wake?.(); });
    // Subscribe before replaying, so nothing emitted during the replay is lost. A reconnecting
    // client sends the seq of the last event it saw; when it does, `hello` carries that cursor back
    // and each replayed frame below advances it, so the client stays in step with us.
    const resuming = sinceSeq !== null && Number.isFinite(sinceSeq);
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now(), seq: resuming ? sinceSeq : hub.seq(user.id) }) });
    if (resuming) {
      for (const ev of hub.since(user.id, sinceSeq).events) await stream.writeSSE({ data: JSON.stringify(ev) });
    }
    while (!stream.aborted) {
      if (!queue.length) {
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 20_000))]);
        wake = null;
        if (!queue.length) { await stream.writeSSE({ data: JSON.stringify({ type: 'ping' }) }); continue; }
      }
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
    }
    unsub();
  });
});

// ---------- desktop app ----------

/**
 * Liveness for the desktop's local stack controller, authenticated by the stack token alone: it
 * runs on the same machine and holds no user session. 403 means this server has no STACK_TOKEN at
 * all, so nothing could ever verify.
 */
api.get('/desktop/probe', async (c) => {
  if (!env.stackToken) return c.json({ error: 'stack token not configured' }, 403);
  if (!stackTokenMatches(c.req.header(ORBIT_HEADERS.stackToken))) return c.json({ error: 'unauthenticated' }, 401);
  const body: DesktopProbeResponse = {
    ok: true,
    imageTag: env.imageTag,
    hermesConnected: await hermesConnected(),
    version: env.version,
  };
  return c.json(body);
});

/** Server-side feature flags for the desktop app. The marker header keeps web requests out. */
api.get('/desktop/config', (c) => {
  if (c.req.header(ORBIT_HEADERS.desktop) !== '1') return c.json({ error: 'desktop client required' }, 403);
  const body: DesktopConfigResponse = {
    updateCheckUrl: env.updateCheckUrl,
    features: { voice: true, pushNotifications: false },
    maxBots: env.maxBots,
    version: env.version,
  };
  return c.json(body);
});

// ---------- push notifications ----------

api.post('/push/register', async (c) => {
  const body = await c.req.json<PushRegisterRequest>().catch(() => ({} as any));
  const platform = body?.platform;
  if (!body?.token || typeof body.token !== 'string') return c.json({ error: 'token required' }, 400);
  if (platform !== 'ios' && platform !== 'android') return c.json({ error: "platform must be 'ios' or 'android'" }, 400);
  registerPushToken(c.get('user').id, body.token, platform as PushPlatform);
  return c.json({ ok: true });
});

api.delete('/push/register', (c) => {
  removePushTokens(c.get('user').id);
  return c.json({ ok: true });
});

// ---------- bots ----------

const ownBot = (userId: string, id: string) => {
  const b = getBotRow(id);
  return b && b.user_id === userId ? b : null;
};

api.get('/bots', (c) => c.json({ bots: listBots(c.get('user').id), live: allLive(c.get('user').id) }));

api.post('/bots', async (c) => {
  const body = await c.req.json();
  try {
    return c.json({ bot: createBot(c.get('user').id, body) });
  } catch (e: any) {
    if (e instanceof UserError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

api.patch('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const p = await c.req.json();
  const cols: Record<string, string> = { name: 'name', label: 'label', description: 'description', instructions: 'instructions', avatarShape: 'avatar_shape', avatarColor: 'avatar_color', mode: 'mode', effort: 'effort', pinned: 'pinned', voice: 'voice', voiceSpeed: 'voice_speed', voiceLanguage: 'voice_language' };
  for (const [k, col] of Object.entries(cols)) {
    if (p[k] !== undefined) db.prepare(`UPDATE bots SET ${col}=?, updated_at=? WHERE id=?`).run(typeof p[k] === 'boolean' ? (p[k] ? 1 : 0) : p[k], now(), b.id);
  }
  if (b.kind !== 'room') {
    if (['name', 'label', 'description'].some((k) => p[k] !== undefined)) syncPersona(b.id);
    // Its desktop carries its name and colour: dress the screen again, if it has one.
    const looks = ['name', 'label', 'avatarShape', 'avatarColor'].some((k) => p[k] !== undefined);
    if (looks) {
      const provider = providerFor(b.id);
      const hasComputer = computerKindFor(b.id) === 'docker'
        ? Boolean(db.prepare('SELECT 1 FROM computer_screens WHERE bot_id=?').get(b.id))
        : Boolean(db.prepare('SELECT 1 FROM screens WHERE bot_id=?').get(b.id));
      if (hasComputer) provider.readyScreen(b.user_id, b.id, { redress: true }).catch((e) => console.warn('[computer] redress failed', e?.message ?? e));
    }
  }
  emitBot(b.id);
  return c.json({ bot: getBot(b.id) });
});

api.delete('/bots/:id', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  for (const r of listRoutines(b.id)) {
    unscheduleRoutine(r.id);
    await deleteEventTrigger(r.id).catch(() => {});
  }
  if (b.kind !== 'room') {
    await removeEngine(b.id).catch((e) => console.warn('[engine] remove failed', e?.message ?? e));
    if (computerKindFor(b.id) === 'docker') {
      await releaseBotComputer(b.id).catch((e) => console.warn('[computer] container cleanup failed', e?.message ?? e));
    } else {
      await releaseScreen(b.id).catch((e) => console.warn('[computer] release failed', e?.message ?? e));
      await forgetBotFiles(b.id).catch((e) => console.warn('[computer] cleanup failed', e?.message ?? e));
    }
  }
  db.prepare('DELETE FROM screens WHERE bot_id=?').run(b.id);
  db.prepare('DELETE FROM bots WHERE id=?').run(b.id);
  hub.emit(c.get('user').id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/primary', (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET is_primary = (id = ?) WHERE user_id=?').run(b.id, user.id);
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

// ---------- conversation ----------

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) });
});

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: 'empty' }, 400);
  const row = appendRow(b.id, 'message', { type: 'message', role: 'user', text: text.trim() });
  // Group chats dispatch to their member Bots instead of running their own loop.
  if (b.kind === 'room') dispatchRoomMessage(b.id, text.trim(), enqueue);
  // Any pending question card is answered by a free-text message.
  else enqueue(b.id, { type: 'user', text: text.trim() });
  return c.json({ row });
});

api.post('/bots/:id/interrupt', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  return c.json({ ok: true });
});

api.post('/bots/:id/fresh', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  interrupt(b.id);
  clearConversation(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.post('/approvals/:id', async (c) => {
  const { decision } = await c.req.json<{ decision: 'allow' | 'always' | 'deny' }>();
  try { resolveApproval(c.get('user').id, c.req.param('id'), decision); } catch { return c.json({ error: 'not found' }, 404); }
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  const { answer } = await c.req.json<{ answer: string }>();
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  updateRow(b.id, row.seq, { ...row.body, status: 'answered', answer });
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  enqueue(b.id, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/dismiss', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  const body: any = { ...row.body, status: row.body.card === 'connect' ? 'skipped' : 'dismissed' };
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  return c.json({ ok: true });
});

// ---------- routines / tasks / memories ----------

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id));
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  runRoutine(r.id);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as any;
  if (!r) return c.json({ error: 'not found' }, 404);
  unscheduleRoutine(r.id);
  await deleteEventTrigger(r.id);
  db.prepare('DELETE FROM routines WHERE id=?').run(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ ok: true });
});

api.get('/bots/:id/tasks', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ tasks: listTasks(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.get('/tasks', (c) => {
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as any[];
  return c.json({ tasks: rows.map((r) => ({ id: r.id, botId: r.bot_id, title: r.title, state: r.state, note: r.note, updatedAt: r.updated_at })) });
});

api.get('/bots/:id/memories', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ memories: listMemories(b.id) });
});

api.delete('/memories/:id', (c) => {
  const botId = memoryBot(c.req.param('id'));
  if (!botId || !ownBot(c.get('user').id, botId)) return c.json({ error: 'not found' }, 404);
  deleteMemory(c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- computer ----------

api.get('/computer', async (c) => c.json({ computer: await refreshComputer(c.get('user').id) }));

api.post('/computer/ensure', (c) => {
  const userId = c.get('user').id;
  ensureComputer(userId).catch((e) => console.warn('[computer] ensure failed', e.message));
  return c.json({ computer: computerState(userId) });
});

api.post('/computer/suspend', async (c) => {
  await suspendComputer(c.get('user').id);
  return c.json({ computer: computerState(c.get('user').id) });
});

api.get('/bots/:id/screenshot', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const provider = providerFor(b.id);
  const scr = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(b.id) as any;
  if (computerKindFor(b.id) === 'docker') {
    const shot = await provider.screenshot(b.id, '').catch(() => null);
    if (!shot) return c.body(null, 204);
    return c.body(new Uint8Array(shot.data), 200, { 'Content-Type': shot.mime, 'Cache-Control': 'no-store' });
  }
  if (!env.orgoComputerId || computerState(user.id).status !== 'running' || !scr) return c.body(null, 204);
  const shot = await provider.screenshot(b.id, scr.screen_id).catch(() => null);
  if (!shot) return c.body(null, 204);
  return c.body(new Uint8Array(shot.data), 200, { 'Content-Type': shot.mime, 'Cache-Control': 'no-store' });
});

/**
 * Take or hand back interactive control of a bot's screen. The relay also uses this: a browser
 * connected with mode=control holds the lease, and the last one out gives it back.
 */
api.post('/bots/:id/screen/control', async (c) => {
  const user = c.get('user');
  const b = ownBot(user.id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({} as any));
  const action = body?.action;
  if (action !== 'take' && action !== 'give') return c.json({ error: "action must be 'take' or 'give'" }, 400);
  const provider = providerFor(b.id);
  try {
    const { screenId } = await provider.screenFor(user.id, b.id);
    if (action === 'take') await provider.takeControl(b.id, screenId);
    else await provider.giveControl(b.id, screenId);
    return c.json({ ok: true, control: action === 'take' ? 'human' : 'bot' });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 502);
  }
});

// ---------- apps (Composio marketplace) ----------

api.get('/apps', async (c) => {
  const user = c.get('user');
  const search = (c.req.query('search') ?? '').toLowerCase();
  const category = c.req.query('category') ?? '';
  const [all, connected] = await Promise.all([catalog().catch(() => []), connectedToolkits(user.id).catch(() => new Set<string>())]);
  let items: Toolkit[] = all.map((t) => ({ ...t, connected: connected.has(t.slug) }));
  if (search) items = items.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search) || t.description?.toLowerCase().includes(search));
  if (category) items = items.filter((t) => t.categories.some((x) => x.toLowerCase() === category.toLowerCase()));
  const categories = [...new Set(all.flatMap((t) => t.categories))].sort();
  const connectedApps = all.filter((t) => connected.has(t.slug)).map((t) => ({ ...t, connected: true }));
  return c.json({ apps: items.slice(0, Number(c.req.query('limit') ?? 120)), connected: [...connected], connectedApps, categories, total: items.length });
});

api.post('/apps/:slug/connect', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const { botId, seq } = await c.req.json<{ botId?: string; seq?: number }>().catch(() => ({} as any));
  const cb = new URL(`${env.serverUrl}/api/apps/callback`);
  cb.searchParams.set('slug', slug);
  if (botId) cb.searchParams.set('bot', botId);
  if (seq) cb.searchParams.set('seq', String(seq));
  const r = await startConnect(user.id, slug, cb.toString());
  return c.json(r);
});

api.get('/apps/callback', async (c) => {
  const userId = userFromCookieHeader(c.req.header('cookie'))?.id ?? '';
  const slug = c.req.query('slug') ?? '';
  const botId = c.req.query('bot');
  const seq = Number(c.req.query('seq') ?? 0);
  const ok = c.req.query('status') !== 'failed';
  const userExists = db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);
  if (userExists && ok) {
    const connected = await connectedToolkits(userId).catch(() => new Set<string>());
    if (connected.has(slug)) {
      hub.emit(userId, { type: 'connections' });
      if (botId && ownBot(userId, botId)) {
        const info = await toolkitInfo(slug);
        if (seq) {
          const row = getRow(botId, seq);
          if (row?.body.type === 'card' && row.body.card === 'connect') updateRow(botId, seq, { ...row.body, status: 'connected' });
        }
        enqueue(botId, { type: 'system', text: `The user connected ${info?.name ?? slug}. Continue with what you were doing.` });
      }
    }
  }
  return c.html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:40px;text-align:center">${ok ? 'Connected. You can close this window.' : 'Connection failed.'}<script>try{window.opener&&window.opener.postMessage({type:'grokbot-connected',slug:${JSON.stringify(slug)},ok:${ok}},'*')}catch(e){};setTimeout(()=>window.close(),800)</script></body>`);
});

api.delete('/apps/:slug', async (c) => {
  await disconnect(c.get('user').id, c.req.param('slug'));
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.get('/policies', (c) => c.json({ policies: db.prepare('SELECT tool, mode FROM policies WHERE user_id=?').all(c.get('user').id) }));
api.delete('/policies/:tool', (c) => {
  db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(c.get('user').id, c.req.param('tool'));
  return c.json({ ok: true });
});

// ---------- Google OAuth2 (direct, no Composio) ----------

api.get('/google/status', (c) => {
  const userId = c.get('user').id;
  if (!env.googleClientId) return c.json({ configured: false, connected: false });
  return c.json({ configured: true, connected: hasGoogleAccess(userId), email: googleEmail(userId) });
});

api.get('/google/connect', async (c) => {
  if (!env.googleClientId || !env.googleClientSecret) return c.json({ error: 'Google OAuth is not configured on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.' }, 503);
  const userId = c.get('user').id;
  const cb = `${env.serverUrl}/api/google/callback`;
  try {
    const url = generateAuthUrl(userId, cb);
    return c.json({ redirectUrl: url });
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

api.get('/google/callback', async (c) => {
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const error = c.req.query('error');
  const cb = `${env.serverUrl}/api/google/callback`;
  const ok = !error && !!code && !!state;
  if (ok) {
    try {
      await exchangeCode(state, code, cb);
    } catch (e) {
      console.error('[google-oauth] callback error', (e as Error).message);
      return c.html(`<!doctype html><meta charset="utf-8"><title>Google</title><body style="font-family:system-ui;padding:40px;text-align:center">Could not connect Google account. Please try again.<script>try{window.opener&&window.opener.postMessage({type:'grokbot-connected',provider:'google',ok:false},'*')}catch(e){}setTimeout(()=>window.close(),2000)</script></body>`);
    }
    hub.emit(
      (db.prepare('SELECT user_id FROM google_oauth_states WHERE state=?').get(state) as any)?.user_id ?? '',
      { type: 'connections' },
    );
  }
  const msg = ok ? 'Google account connected. You can close this window.' : 'Connection failed or was cancelled.';
  return c.html(`<!doctype html><meta charset="utf-8"><title>Google</title><body style="font-family:system-ui;padding:40px;text-align:center">${msg}<script>try{window.opener&&window.opener.postMessage({type:'grokbot-connected',provider:'google',ok:${ok}},'*')}catch(e){}setTimeout(()=>window.close(),800)</script></body>`);
});

api.delete('/google', async (c) => {
  await revokeGoogle(c.get('user').id);
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.route('/voice', voiceApi);

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { asUserId, ORBIT_HEADERS, type CardBody, type DesktopConfigResponse, type DesktopProbeResponse, type PushPlatform, type SignInResponse } from '@orbit/contracts';
import { db, now } from './db.js';
import { env } from './env.js';
import { newId } from './lib/ids.js';
import { hub } from './lib/hub.js';
import { createSession, destroySession, isOwnerKey, issueSessionToken, requireUser, userFromAuthorizationHeader, userFromCookieHeader, userFromToken, type AuthVars } from './lib/auth.js';
import { stackTokenMatches } from './lib/stack.js';
import { hermesConnected } from './lib/hermes-probe.js';
import { registerPushToken, removePushToken, removePushTokens } from './push.js';
import { allLive, appendRow, clearConversation, emitBot, getBot, getRow, listBots, listRoutines, listRows, listTasks, toRoutine, updateRow, type RoutineRow, type TaskRow } from './store.js';
import { enqueue, interrupt, resolveApproval, touchApproval } from './agent/loop.js';
import { ReviewEditError } from './review/index.js';
import { actOnDraft } from './review/drafts.js';
import { ApiError } from './api/errors.js';
import { clearMirror } from './calendar/mirror.js';
import { computerState, ensureComputer, refreshComputer, suspendComputer } from './computer.js';
import { computerKindFor, providerFor } from './computer-provider-registry.js';
import { deleteMemory, listMemories, memoryBot } from './engine-memory.js';
import { orgo } from './orgo.js';
import { catalog, composioEnabled, connectedToolkits, connectionHealthOf, deleteConnection, disconnect, googleProfile, startConnect, startGoogleLogin, toolkitInfo } from './composio.js';
import { connectionWatch } from './core/connection-watch.js';
import { libraryRoot, safeRel } from './files.js';
import { mediaTypeFor } from './lib/mime.js';
import { runRoutine, scheduleRoutine, unscheduleRoutine } from './routines.js';
import { deleteEventTrigger } from './triggers.js';
import { dispatchRoomMessage } from './agent/rooms.js';
import { voiceApi } from './voice.js';
import { templatesApi } from './routes-templates.js';
import type { Toolkit } from '@orbit/contracts';
import { TeamFullError } from './core/bot-service.js';
import { createBotFor, deleteBotFor, setBotPrimary, updateBotFor } from './bot-admin.js';
import { decideCard } from './core/card-service.js';
import type { CardEvent } from './domain/card-workflow.js';
import { botRow, botRowsForUser, type BotRow } from './infra/bot-repository.js';
import {
  AppConnectSchema,
  ApprovalDecisionSchema,
  DraftActionSchema,
  CardAnswerSchema,
  CardDismissSchema,
  CreateBotSchema,
  DevLoginSchema,
  optionalBody,
  OwnerSignInSchema,
  PatchBotSchema,
  PushRegisterSchema,
  PushTokenQuerySchema,
  requireBody,
  RoutineEnableSchema,
  ScreenControlSchema,
  SendMessageSchema,
  SignInSchema,
} from './api/schemas.js';

export const api = new Hono<AuthVars>();

/** Every sign-in failure answers 403; only one raised for the person keeps its message. */
const signInError = (e: unknown): ApiError =>
  e instanceof ApiError || e instanceof TeamFullError ? new ApiError(403, e.message) : new ApiError(403, 'could not sign in');

/** Message off a caught value, which may be an Error or anything a dependency threw. */
const messageOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

function findOrCreateUser(email: string, name?: string, preferId?: string) {
  const existing = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email) as { id: string } | undefined;
  if (existing) return { id: existing.id, isNew: false };
  if (env.allowedEmails.length && !env.allowedEmails.includes(email.toLowerCase())) throw new ApiError(403, 'This account is not allowed to sign in here.');
  const id = preferId ?? newId('usr');
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, name ?? email.split('@')[0], now());
  createBotFor(id, { name: env.primaryBotName, label: env.primaryBotLabel, description: 'Your main point of contact. Checks in proactively and coordinates work with your other Bots.', avatarShape: 'blob', avatarColor: 'black', isPrimary: true });
  return { id, isNew: true };
}

api.get('/auth/me', (c) => {
  const user = userFromCookieHeader(c.req.header('cookie')) ?? userFromAuthorizationHeader(c.req.header('authorization'));
  return c.json({ user, devLogin: env.devLogin });
});

api.patch('/auth/me', requireUser, async (c) => {
  const userId = c.get('user').id;
  const body = await c.req.json() as { avatarUrl?: string | null; timezone?: unknown };
  if (body.avatarUrl !== undefined) {
    db.prepare('UPDATE users SET avatar_url=? WHERE id=?').run(body.avatarUrl ?? null, userId);
  }
  // The device's timezone, so bots read and write times in the person's own time.
  if (typeof body.timezone === 'string' && body.timezone.length <= 64) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: body.timezone });
      db.prepare('UPDATE users SET timezone=? WHERE id=?').run(body.timezone, userId);
    } catch {
      return c.json({ error: 'Not a timezone.' }, 400);
    }
  }
  return c.json({ user: { ...c.get('user'), avatarUrl: body.avatarUrl ?? c.get('user').avatarUrl } });
});

api.post('/auth/avatar', requireUser, async (c) => {
  const userId = c.get('user').id;
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'No file' }, 400);
  const ext = file.name.includes('.') ? '.' + file.name.split('.').pop()!.toLowerCase() : '';
  const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
  if (ext && !allowed.includes(ext)) return c.json({ error: 'Unsupported image format' }, 400);
  const avatarDir = path.join(libraryRoot('_avatars'), userId);
  fs.mkdirSync(avatarDir, { recursive: true });
  const filename = `avatar${ext}`;
  const dest = path.join(avatarDir, filename);
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(dest, buf);
  const url = `/api/auth/avatar/${userId}/${filename}`;
  db.prepare('UPDATE users SET avatar_url=? WHERE id=?').run(url, userId);
  return c.json({ url });
});

api.get('/auth/avatar/:userId/:filename', (c) => {
  const { userId, filename } = c.req.param();
  const filePath = path.join(libraryRoot('_avatars'), userId, filename);
  if (!fs.existsSync(filePath)) return c.json({ error: 'Not found' }, 404);
  const mt = mediaTypeFor(filename) ?? 'application/octet-stream';
  return c.newResponse(fs.readFileSync(filePath), 200, { 'Content-Type': mt });
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
  const attempt = db.prepare('SELECT * FROM login_attempts WHERE id=?').get(c.req.query('attempt') ?? '') as
    | { id: string; provisional_user_id: string; connected_account_id: string | null }
    | undefined;
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
  } catch (e) {
    console.error('[auth] google callback', e);
    return c.redirect(`${env.appUrl}/?login=failed`);
  }
});

api.post('/auth/dev', async (c) => {
  if (!env.devLogin) return c.json({ error: 'disabled' }, 403);
  const { email, name } = await requireBody(c, DevLoginSchema);
  if (!email?.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, name);
    createSession(c, id);
    return c.json({ ok: true });
  } catch (e) {
    throw signInError(e);
  }
});

/**
 * Sign-in for the native clients: same sessions table as the cookie flow, but the token comes back
 * in the body (and no cookie is set), so it can live in expo-secure-store or the desktop keystore.
 * Only the owner key, or a dev server, may mint one — there is no password store to check against.
 */
api.post('/auth/sign-in', async (c) => {
  const body = await requireBody(c, SignInSchema);
  const email = String(body.email ?? '').trim();
  const byOwnerKey = Boolean(body.ownerKey) && isOwnerKey(String(body.ownerKey));
  if (!byOwnerKey && !env.devLogin) return c.json({ error: 'owner key required' }, 403);
  if (!email.includes('@')) return c.json({ error: 'email required' }, 400);
  try {
    const { id } = findOrCreateUser(email, body.name);
    const { token, expiresAt } = issueSessionToken(id);
    const user = userFromToken(token);
    if (!user) return c.json({ error: 'could not sign in' }, 500);
    return c.json({ ok: true, token, user, expiresAt } satisfies SignInResponse);
  } catch (e) {
    throw signInError(e);
  }
});

/** One-time sign-in links made by the owner endpoint. Kept in memory: a restart drops them. */
const signInLinks = new Map<string, { userId: string; expires: number }>();

// Sign-in for whoever runs the server, without Google: the key only exists on the machine (see isOwnerKey).
// With `link`, it answers with a link that signs one browser in, once (scripts/sign-in-link.sh).
api.post('/auth/owner', async (c) => {
  if (!isOwnerKey((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''))) return c.json({ error: 'forbidden' }, 403);
  const { email, name, link } = await requireBody(c, OwnerSignInSchema);
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
  } catch (e) {
    throw signInError(e);
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

// Ahead of the sign-in middleware: a template share link is readable before signing in.
api.route('/', templatesApi);

api.use('/*', async (c, next) => {
  // /api/desktop/probe is authenticated by the stack token itself (see its handler).
  if (c.req.path.startsWith('/api/auth/') || c.req.path.startsWith('/api/apps/callback') || c.req.path === '/api/health' || c.req.path === '/api/desktop/probe') return next();
  return requireUser(c, next);
});

api.get('/events', (c) => {
  const user = c.get('user');
  const sinceRaw = c.req.query('since');
  const sinceSeq = sinceRaw !== undefined && sinceRaw !== '' ? Number(sinceRaw) : null;
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsub = hub.subscribe(user.id, (ev) => { queue.push(JSON.stringify(ev)); wake?.(); });
    stream.onAbort(() => { unsub(); wake?.(); });
    // Subscribe before replaying, so nothing emitted during the replay is lost. `hello` always
    // carries the server's own current cursor — never the client's `since` — because that number is
    // the only one a client can safely resume from: echoing `since` back would leave a client whose
    // `since` is ahead of the buffer permanently ahead of it.
    const cursor = hub.seq(user.id);
    const resuming = sinceSeq !== null && Number.isFinite(sinceSeq);
    await stream.writeSSE({ data: JSON.stringify({ type: 'hello', serverTime: now(), seq: cursor }) });
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

api.post('/push/register', async (c) => {
  const body = await requireBody(c, PushRegisterSchema);
  const platform = body.platform;
  if (!body.token || typeof body.token !== 'string') return c.json({ error: 'token required' }, 400);
  if (platform !== 'ios' && platform !== 'android') return c.json({ error: "platform must be 'ios' or 'android'" }, 400);
  registerPushToken(c.get('user').id, body.token, platform as PushPlatform);
  return c.json({ ok: true });
});

/**
 * Forgets one device's token when the body or query names it, so signing out on a phone does not
 * silence the others. A client that cannot say which token is its own still clears the account.
 * The body is optional (a DELETE often has none), hence optionalBody rather than requireBody.
 */
api.delete('/push/register', async (c) => {
  const body = await optionalBody(c, PushTokenQuerySchema, {});
  const token = c.req.query('token') ?? (typeof body.token === 'string' ? body.token : '');
  if (token) removePushToken(c.get('user').id, token);
  else removePushTokens(c.get('user').id);
  return c.json({ ok: true });
});

const ownBot = (userId: string, id: string): BotRow | null => {
  const b = botRow(id);
  return b && b.user_id === userId ? b : null;
};

api.get('/bots', (c) => c.json({ bots: listBots(c.get('user').id), live: allLive(c.get('user').id) }));

api.post('/bots', async (c) => {
  const body = await requireBody(c, CreateBotSchema);
  return c.json({ bot: createBotFor(c.get('user').id, body) });
});

api.patch('/bots/:id', async (c) => {
  const p = await requireBody(c, PatchBotSchema);
  return c.json({ bot: updateBotFor(c.get('user').id, c.req.param('id'), p) });
});

api.delete('/bots/:id', async (c) => {
  const { promoted } = await deleteBotFor(c.get('user').id, c.req.param('id'));
  return c.json({ ok: true, promoted });
});

/**
 * Make a Bot primary. Idempotent; a team allows MAX_PRIMARY_BOTS primaries at once, and this no
 * longer demotes the others (that was the single-primary rule).
 */
api.post('/bots/:id/primary', (c) => {
  const { primaries } = setBotPrimary(c.get('user').id, c.req.param('id'), 'promote');
  return c.json({ ok: true, primaries });
});

/** Restore a primary Bot to default. Refused when it is the last one, so the team keeps a coordinator. */
api.post('/bots/:id/primary/restore', (c) => {
  const { primaries } = setBotPrimary(c.get('user').id, c.req.param('id'), 'restore');
  return c.json({ ok: true, primaries });
});

api.post('/bots/:id/read', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('UPDATE bots SET unread=0 WHERE id=?').run(b.id);
  emitBot(b.id);
  return c.json({ ok: true });
});

api.get('/bots/:id/rows', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const beforeSeq = c.req.query('beforeSeq') ? Number(c.req.query('beforeSeq')) : undefined;
  return c.json({ generation: b.generation, rows: listRows(b.id, { beforeSeq, limit: Number(c.req.query('limit') ?? 200) }) });
});

api.post('/bots/:id/attachments', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) return c.json({ error: 'file required' }, 400);
  if (file.size > 50 * 1024 * 1024) return c.json({ error: 'file too large (max 50 MB)' }, 413);

  const rawName = file.name ?? 'upload';
  const safeName = path.basename(rawName).replace(/[^\w.\-]/g, '_').slice(0, 200) || 'upload';
  if (!safeRel(`attachments/${safeName}`)) return c.json({ error: 'invalid filename' }, 400);

  const dir = path.join(libraryRoot(b.id), 'attachments');
  fs.mkdirSync(dir, { recursive: true });

  let dest = path.join(dir, safeName);
  if (fs.existsSync(dest)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    let n = 1;
    while (fs.existsSync(dest)) { dest = path.join(dir, `${base}_${n++}${ext}`); }
  }
  const finalName = path.basename(dest);

  fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
  return c.json({ path: `attachments/${finalName}`, filename: finalName, mediaType: mediaTypeFor(finalName) });
});

api.post('/bots/:id/messages', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { text, files } = await requireBody(c, SendMessageSchema);
  if (!text?.trim()) return c.json({ error: 'empty' }, 400);
  const trimmed = text.trim();
  const body: { type: 'message'; role: 'user'; text: string; files?: typeof files } = { type: 'message', role: 'user', text: trimmed };
  if (Array.isArray(files) && files.length > 0) body.files = files;
  const row = appendRow(b.id, 'message', body);
  // Group chats dispatch to their member Bots instead of running their own loop.
  if (b.kind === 'room') dispatchRoomMessage(b.id, trimmed, enqueue);
  // Any pending question card is answered by a free-text message.
  else enqueue(b.id, { type: 'user', text: trimmed });
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
  const { decision, edits } = await requireBody(c, ApprovalDecisionSchema);
  try {
    resolveApproval(c.get('user').id, c.req.param('id'), decision, edits);
  } catch (e) {
    if (e instanceof ReviewEditError) throw e;
    return c.json({ error: 'not found' }, 404);
  }
  return c.json({ ok: true });
});

/** Save, send or discard a Gmail draft a bot wrote, from its email card. */
api.post('/bots/:id/cards/:seq/draft', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const { action, edits } = await requireBody(c, DraftActionSchema);
  const { card, tell } = await actOnDraft(c.get('user').id, b.id, Number(c.req.param('seq')), action, edits);
  if (tell) enqueue(b.id, { type: 'system', text: tell });
  return c.json({ card });
});

/** The person is editing an approval card: keep the bot's call waiting for them (up to two hours in all). */
api.post('/approvals/:id/editing', (c) => {
  try {
    return c.json({ ok: touchApproval(c.get('user').id, c.req.param('id')) });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

api.post('/bots/:id/cards/:seq/answer', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  const { answer } = await requireBody(c, CardAnswerSchema);
  if (!row || row.body.type !== 'card' || row.body.card !== 'question') return c.json({ error: 'not a question' }, 400);
  // Already decided: idempotent success, like resolveApproval on a settled approval. A second tap
  // must not append the answer to the conversation a second time.
  if (row.body.status !== 'pending') return c.json({ ok: true });
  const body = decideCard(row.body, { type: 'answer', userId: c.get('user').id, at: now(), answer }, String(row.seq));
  updateRow(b.id, row.seq, body);
  appendRow(b.id, 'message', { type: 'message', role: 'user', text: answer });
  enqueue(b.id, { type: 'user', text: `[Answer to "${row.body.question}"] ${answer}` });
  return c.json({ ok: true });
});

api.post('/bots/:id/cards/:seq/dismiss', async (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const row = getRow(b.id, Number(c.req.param('seq')));
  // Nothing is read from the body; parsing it keeps this route under the same boundary rule as the rest.
  await optionalBody(c, CardDismissSchema, {});
  if (!row || row.body.type !== 'card') return c.json({ error: 'not a card' }, 400);
  // Already decided: idempotent success (a double-tapped Skip), and no repeated system message.
  if (row.body.status !== 'pending') return c.json({ ok: true });
  // Skipping a connect card is the machine's 'skip'; every other card is dismissed. A draft becomes
  // 'discarded' (its only legal terminal state), which the old code got wrong by writing 'dismissed'.
  const event: CardEvent = row.body.card === 'connect'
    ? { type: 'skip', userId: c.get('user').id, at: now() }
    : { type: 'dismiss', userId: c.get('user').id, at: now() };
  const body = decideCard(row.body, event, String(row.seq));
  updateRow(b.id, row.seq, body);
  if (row.body.card === 'connect') enqueue(b.id, { type: 'system', text: `The user skipped connecting ${row.body.toolkitName}. Continue without it.` });
  if (row.body.card === 'secure-form') enqueue(b.id, { type: 'system', text: `The user closed the secure form for "${row.body.label}" without entering anything. Continue without that login, or ask them how they want to proceed.` });
  return c.json({ ok: true });
});

api.get('/bots/:id/routines', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  return b ? c.json({ routines: listRoutines(b.id) }) : c.json({ error: 'not found' }, 404);
});

api.patch('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as RoutineRow | undefined;
  if (!r) return c.json({ error: 'not found' }, 404);
  const { enabled } = await requireBody(c, RoutineEnableSchema);
  db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, r.id);
  const next = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(r.id) as RoutineRow);
  enabled ? scheduleRoutine(next) : unscheduleRoutine(r.id);
  hub.emit(c.get('user').id, { type: 'routines', botId: r.bot_id });
  return c.json({ routine: next });
});

api.post('/routines/:id/run', (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as RoutineRow | undefined;
  if (!r) return c.json({ error: 'not found' }, 404);
  runRoutine(r.id);
  return c.json({ ok: true });
});

api.delete('/routines/:id', async (c) => {
  const r = db.prepare('SELECT r.* FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=? AND b.user_id=?').get(c.req.param('id'), c.get('user').id) as RoutineRow | undefined;
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
  const rows = db.prepare('SELECT t.* FROM tasks t JOIN bots b ON b.id=t.bot_id WHERE b.user_id=? ORDER BY t.updated_at DESC LIMIT 200').all(c.get('user').id) as TaskRow[];
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

api.get('/computer', async (c) => c.json({ computer: await refreshComputer(c.get('user').id) }));

api.post('/computer/ensure', async (c) => {
  const userId = c.get('user').id;
  // Two kinds of computer behind one button. With an Orgo machine, wake it. Without one, every
  // bot's desktop is its own container, so "wake" means create/start the containers — asking Orgo
  // here (which has no id) is what made the viewer's Retry fail with a 500 instead of a screen.
  if (!env.orgoComputerId && env.computerKind !== 'orgo') {
    // Every visible bot of this user, oldest first: rooms dispatch to members and hidden subagents
    // keep their parent's screen, so neither owns a container here.
    const bots = botRowsForUser(userId).filter((b) => b.kind !== 'room' && !b.hidden);
    // Booting a container (and, the first time, building the computer image) takes far longer than a
    // request should. Answer at once with the current state; the viewer follows the computer's state
    // over SSE and the screen opens when it is ready.
    for (const b of bots) {
      if (computerKindFor(b.id) !== 'docker') continue;
      void providerFor(b.id)
        .ensureComputer(b.id)
        .catch((e: Error) => console.warn(`[computer] ${b.id} did not start: ${e.message}`));
    }
    return c.json({ computer: computerState(userId) });
  }
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
  const scr = db.prepare('SELECT screen_id FROM screens WHERE bot_id=?').get(b.id) as { screen_id: string } | undefined;
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
  const body = await requireBody(c, ScreenControlSchema);
  const action = body.action;
  if (action !== 'take' && action !== 'give') return c.json({ error: "action must be 'take' or 'give'" }, 400);
  const provider = providerFor(b.id);
  try {
    const { screenId } = await provider.screenFor(user.id, b.id);
    if (action === 'take') await provider.takeControl(b.id, screenId);
    else await provider.giveControl(b.id, screenId);
    return c.json({ ok: true, control: action === 'take' ? 'human' : 'bot' });
  } catch (e) {
    return c.json({ error: messageOf(e) }, 502);
  }
});

api.get('/apps', async (c) => {
  const user = c.get('user');
  const search = (c.req.query('search') ?? '').toLowerCase();
  const category = c.req.query('category') ?? '';
  const [all, { connected, expired }] = await Promise.all([
    catalog().catch(() => []),
    connectionHealthOf(user.id).catch(() => ({ connected: new Set<string>(), expired: new Set<string>() })),
  ]);
  let items: Toolkit[] = all.map((t) => ({ ...t, connected: connected.has(t.slug), ...(expired.has(t.slug) ? { needsReconnect: true as const } : {}) }));
  if (search) items = items.filter((t) => t.name.toLowerCase().includes(search) || t.slug.includes(search) || t.description?.toLowerCase().includes(search));
  if (category) items = items.filter((t) => t.categories.some((x) => x.toLowerCase() === category.toLowerCase()));
  const categories = [...new Set(all.flatMap((t) => t.categories))].sort();
  const connectedApps = all.filter((t) => connected.has(t.slug)).map((t) => ({ ...t, connected: true }));
  const expiredApps: Toolkit[] = all.filter((t) => expired.has(t.slug)).map((t) => ({ ...t, connected: false, needsReconnect: true }));
  return c.json({ apps: items.slice(0, Number(c.req.query('limit') ?? 120)), connected: [...connected], connectedApps, expiredApps, categories, total: items.length });
});

api.post('/apps/:slug/connect', async (c) => {
  const user = c.get('user');
  const slug = c.req.param('slug');
  const { botId, seq } = await requireBody(c, AppConnectSchema);
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
      // A reconnect made from anywhere closes the reconnect cards that were waiting on it.
      void connectionWatch.check(userId).catch(() => {});
      if (botId && ownBot(userId, botId)) {
        const info = await toolkitInfo(slug);
        if (seq) {
          const row = getRow(botId, seq);
          // The connection completing is the connect card's own 'connect' event. A card that is
          // already decided is left alone, which is what its terminal state means.
          if (row?.body.type === 'card' && row.body.card === 'connect' && row.body.status === 'pending') {
            updateRow(botId, seq, decideCard(row.body, { type: 'connect', userId, at: now() }, String(seq)));
          }
        }
        enqueue(botId, { type: 'system', text: `The user connected ${info?.name ?? slug}. Continue with what you were doing.` });
      }
    }
  }
  return c.html(`<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;padding:40px;text-align:center">${ok ? 'Connected. You can close this window.' : 'Connection failed.'}<script>try{window.opener&&window.opener.postMessage({type:'grokbot-connected',slug:${JSON.stringify(slug)},ok:${ok}},'*')}catch(e){};setTimeout(()=>window.close(),800)</script></body>`);
});

api.delete('/apps/:slug', async (c) => {
  await disconnect(c.get('user').id, c.req.param('slug'));
  // Disconnecting Google Calendar forgets its mirrored events.
  if (c.req.param('slug') === 'googlecalendar') clearMirror(c.get('user').id);
  hub.emit(c.get('user').id, { type: 'connections' });
  return c.json({ ok: true });
});

api.get('/policies', (c) => c.json({ policies: db.prepare('SELECT tool, mode FROM policies WHERE user_id=?').all(c.get('user').id) }));
api.delete('/policies/:tool', (c) => {
  db.prepare('DELETE FROM policies WHERE user_id=? AND tool=?').run(c.get('user').id, c.req.param('tool'));
  return c.json({ ok: true });
});

// Per-bot "Always allow": what the person always-allowed for one Bot (used only while that Bot's
// alwaysAllow setting is on), and removing one.
api.get('/bots/:id/policies', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  const rows = db.prepare('SELECT tool, created_at FROM bot_policies WHERE bot_id=? ORDER BY created_at').all(b.id) as { tool: string; created_at: number }[];
  return c.json({ policies: rows.map((r) => ({ tool: r.tool, createdAt: r.created_at })) });
});
api.delete('/bots/:id/policies/:tool', (c) => {
  const b = ownBot(c.get('user').id, c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  db.prepare('DELETE FROM bot_policies WHERE bot_id=? AND tool=?').run(b.id, c.req.param('tool'));
  return c.json({ ok: true });
});

api.route('/voice', voiceApi);

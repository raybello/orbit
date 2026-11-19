import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { VaultResponse } from '@orbit/contracts';
import { requireBody } from './api/schemas.js';
import { enqueue } from './core/turn-queue.js';
import { decideCard } from './core/card-service.js';
import { now } from './db.js';
import { botRow } from './infra/bot-repository.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { getRow, updateRow } from './store.js';
import {
  deleteVaultEntry, listVaultEntries, ONE_TIME_TTL_MS, oneTimeLabel, parseLabel, parseSecret, parseStoredUrlPattern, parseUsername,
  saveVaultEntry, updateVaultEntry, VaultError, vaultStatus, type VaultPatch,
} from './vault.js';

/**
 * /api/vault: the logins a person keeps for their bots, and the route a secure form posts to.
 *
 * Secrets only travel inward here. Every answer is an entry's name, username and site; there is no
 * route that reads a secret back, so changing one means typing it again.
 */

/** Only "it is a JSON object": vault.ts names what is wrong with a field, in words meant for a person. */
const VaultBodySchema = z.object({}).loose();

/** POST /api/bots/:id/cards/:seq/secure-form */
const SecureFormSchema = z.object({ values: z.object({}).loose(), save: z.boolean().optional() }).loose();

function fail(c: Context, e: unknown) {
  if (e instanceof VaultError) return c.json({ error: e.message }, e.status);
  throw e;
}

export const vaultApi = new Hono<AuthVars>();

vaultApi.get('/vault', requireUser, (c) => {
  const body: VaultResponse = { configured: vaultStatus().configured, entries: listVaultEntries(c.get('user').id) };
  return c.json(body);
});

vaultApi.post('/vault', requireUser, async (c) => {
  const raw = await requireBody(c, VaultBodySchema);
  try {
    const entry = saveVaultEntry(c.get('user').id, {
      label: parseLabel(raw.label),
      username: parseUsername(raw.username),
      secret: parseSecret(raw.secret),
      urlPattern: parseStoredUrlPattern(raw.urlPattern),
    });
    return c.json({ entry }, 201);
  } catch (e) {
    return fail(c, e);
  }
});

vaultApi.patch('/vault/:id', requireUser, async (c) => {
  const raw = await requireBody(c, VaultBodySchema);
  try {
    const patch: VaultPatch = {};
    if (raw.label !== undefined) patch.label = parseLabel(raw.label);
    if (raw.username !== undefined) patch.username = parseUsername(raw.username);
    // There is no reading a secret back, so an empty field means "leave it", not "clear it".
    if (raw.secret !== undefined && raw.secret !== '') patch.secret = parseSecret(raw.secret);
    if (raw.urlPattern !== undefined) patch.urlPattern = parseStoredUrlPattern(raw.urlPattern);
    return c.json({ entry: updateVaultEntry(c.get('user').id, c.req.param('id'), patch) });
  } catch (e) {
    return fail(c, e);
  }
});

vaultApi.delete('/vault/:id', requireUser, (c) => {
  if (!deleteVaultEntry(c.get('user').id, c.req.param('id'))) return c.json({ error: 'No such login.' }, 404);
  return c.json({ ok: true });
});

/**
 * A secure form's values, straight from the person's browser. They are sealed into the Vault and the
 * card is marked submitted; the bot is told only that a login now exists under a name it can ask for.
 */
vaultApi.post('/bots/:id/cards/:seq/secure-form', requireUser, async (c) => {
  const user = c.get('user');
  const bot = botRow(c.req.param('id'));
  if (!bot || bot.user_id !== user.id) return c.json({ error: 'not found' }, 404);
  const { values, save = false } = await requireBody(c, SecureFormSchema);
  const row = getRow(bot.id, Number(c.req.param('seq')));
  if (!row || row.body.type !== 'card' || row.body.card !== 'secure-form') return c.json({ error: 'not a secure form' }, 400);
  // Already decided: a double submit must not store a second login or wake the bot twice.
  if (row.body.status !== 'pending') return c.json({ ok: true });
  const card = row.body;
  try {
    const entry = saveVaultEntry(
      user.id,
      {
        label: save ? card.label : oneTimeLabel(card.label),
        username: card.fields.some((f) => f.key === 'username') ? parseUsername(values.username) : null,
        secret: parseSecret(values.secret),
        urlPattern: card.urlPattern ?? null,
      },
      { replace: true, expiresAt: save ? null : now() + ONE_TIME_TTL_MS },
    );
    updateRow(bot.id, row.seq, decideCard(card, { type: 'submit', userId: user.id, at: now(), saved: save }, String(row.seq)));
    enqueue(bot.id, {
      type: 'system',
      text: `The user filled in the secure form for "${card.label}". The login is in their Vault as "${entry.label}"${save ? '' : ` for the next ${ONE_TIME_TTL_MS / 60_000} minutes`}. Click the sign-in field on your screen, then call vault_lookup with label "${entry.label}" to have it typed. You were not given the values.`,
    });
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e);
  }
});
